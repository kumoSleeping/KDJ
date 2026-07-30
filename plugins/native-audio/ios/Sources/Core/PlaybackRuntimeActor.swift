@preconcurrency import Foundation
import UIKit

private let seekCommitEpsilonSeconds = 0.02
private let foregroundProgressEmitIntervalSeconds = 1.0 / 40.0
private let backgroundProgressEmitIntervalSeconds = 0.25

protocol NativeAudioEventEmitter: AnyObject, Sendable {
  func emitNativeAudioState(_ state: NativeAudioState)
}

actor PlaybackRuntimeActor {
  static let shared = PlaybackRuntimeActor()

  private let playerAdapter = PlayerAdapter()
  private let audioSessionController = AudioSessionController()
  private let nowPlayingController = NowPlayingController()
  private let remoteCommandController = RemoteCommandController()
  private let sourceResolver = SourceResolver()
  private let checkpointStore = CheckpointStore()

  private weak var emitter: NativeAudioEventEmitter?

  private var machine = PlaybackStateMachine()
  private var isConfigured = false
  private var wasPlayingBeforeInterruption = false
  private var isAppInForeground = true
  private var queue: [SetSourceArgs] = []

  private var lastEmittedState: NativeAudioState?
  private var lastProgressTickEmitAt = Date.distantPast
  private var appDidBecomeActiveObserver: NSObjectProtocol?
  private var appDidEnterBackgroundObserver: NSObjectProtocol?

  private enum EmitTrigger {
    case transition
    case progressTick
  }

  func attachEmitter(_ emitter: NativeAudioEventEmitter?) {
    self.emitter = emitter
  }

  func initialize() async throws -> NativeAudioState {
    await ensureConfigured()
    try audioSessionController.configurePlaybackCategory()
    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
    return snapshot()
  }

  func setSource(
    src: String,
    id: Int64?,
    title: String?,
    artist: String?,
    album: String?,
    artworkURL: String?,
    preserveQueue: Bool = false
  ) async throws -> NativeAudioState {
    await ensureConfigured()
    try audioSessionController.configurePlaybackCategory()

    let playbackURL = try await sourceResolver.resolvePlayableURL(src: src)
    if !preserveQueue {
      queue.removeAll()
    }
    let sourceRevision = machine.advanceSourceRevision()
    machine.setStoryId(id)
    machine.setMetadata(
      PlaybackMetadata(title: title, artist: artist, album: album, artworkURL: artworkURL)
    )

    wasPlayingBeforeInterruption = false
    playerAdapter.pause()
    playerAdapter.replaceCurrentItem(url: playbackURL, sourceRevision: sourceRevision)

    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: true)
    return snapshot()
  }

  func setQueue(items: [SetSourceArgs]) async throws -> NativeAudioState {
    guard !items.isEmpty else {
      throw NativeAudioRuntimeError.invalidSource
    }
    queue = items
    if let currentID = machine.currentStoryId, items.contains(where: { $0.id == currentID }) {
      return snapshot()
    }
    return try await loadQueueItem(items[0], resume: machine.desiredPlaying)
  }

  private func skipQueue(by offset: Int) async throws -> NativeAudioState {
    guard !queue.isEmpty else { return snapshot() }
    let currentIndex = machine.currentStoryId
      .flatMap { currentID in queue.firstIndex(where: { $0.id == currentID }) } ?? 0
    let targetIndex = currentIndex + offset
    guard queue.indices.contains(targetIndex) else {
      if offset < 0 {
        return await seekTo(position: 0)
      }
      return snapshot()
    }
    let item = queue[targetIndex]
    let resume = machine.desiredPlaying
    return try await loadQueueItem(item, resume: resume)
  }

  private func loadQueueItem(_ item: SetSourceArgs, resume: Bool) async throws -> NativeAudioState {
    let state = try await setSource(
      src: item.src,
      id: item.id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      artworkURL: item.artworkUrl,
      preserveQueue: true
    )
    if resume {
      return try await play()
    }
    return state
  }

  func play() async throws -> NativeAudioState {
    await ensureConfigured()
    try audioSessionController.configurePlaybackCategory()
    try audioSessionController.setActive(true)
    machine.setDesiredPlaying(true)

    if machine.didReachEnd {
      machine.clearEnded()
      let pending = machine.beginSeek(position: 0.0, shouldResume: true, originPosition: playerAdapter.currentTimeSeconds())
      playerAdapter.seek(to: 0.0, sourceRevision: pending.sourceRevision, seekRevision: pending.revision)
    }

    machine.clearError()
    playerAdapter.play(rate: machine.playbackRate)

    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
    return snapshot()
  }

  func pause() async -> NativeAudioState {
    machine.setDesiredPlaying(false)
    machine.clearPendingSeek()
    playerAdapter.pause()

    emitState(trigger: .transition, forcePersistCheckpoint: true, forceEmit: true, refreshArtwork: false)
    return snapshot()
  }

  func stop() async -> NativeAudioState {
    _ = await pause()
    return await seekTo(position: 0)
  }

  func seekTo(position: Double) async -> NativeAudioState {
    let safePosition = max(0.0, position)
    let shouldResume = machine.desiredPlaying

    machine.clearEnded()
    let pending = machine.beginSeek(position: safePosition, shouldResume: shouldResume, originPosition: playerAdapter.currentTimeSeconds())

    if !shouldResume {
      playerAdapter.pause()
    }

    playerAdapter.seek(to: safePosition, sourceRevision: pending.sourceRevision, seekRevision: pending.revision)

    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
    return snapshot()
  }

  func setRate(rate: Double) async throws -> NativeAudioState {
    guard rate.isFinite, rate > 0 else {
      throw NativeAudioRuntimeError.invalidRate
    }

    machine.setPlaybackRate(rate)
    playerAdapter.setRate(rate)

    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
    return snapshot()
  }

  func setVolume(volume: Double) -> NativeAudioState {
    playerAdapter.setVolume(volume)
    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
    return snapshot()
  }

  func getState() -> NativeAudioState {
    snapshot()
  }

  func getProgressCheckpoint() -> NativeAudioProgressCheckpoint? {
    checkpointStore.read()
  }

  func clearProgressCheckpoint() {
    checkpointStore.clear()
  }

  func dispose() async {
    let preDisposeSnapshot = snapshot()
    checkpointStore.persistIfNeeded(snapshot: preDisposeSnapshot, storyId: machine.currentStoryId, force: true)

    remoteCommandController.unregister()
    audioSessionController.unregisterObservers()
    unregisterAppLifecycleObservers()

    nowPlayingController.clear()
    playerAdapter.dispose()

    await sourceResolver.cleanupAll()

    machine.resetAll()
    queue.removeAll()
    wasPlayingBeforeInterruption = false
    lastEmittedState = nil
    lastProgressTickEmitAt = .distantPast
    isConfigured = false

    try? audioSessionController.setActive(false)
    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
  }

  private func ensureConfigured() async {
    if isConfigured {
      return
    }
    let lifecycle = await MainActor.run {
      (
        UIApplication.shared.applicationState == .active,
        UIApplication.didBecomeActiveNotification,
        UIApplication.didEnterBackgroundNotification
      )
    }
    // Actor reentrancy is possible while awaiting MainActor; another call may have completed setup.
    if isConfigured { return }

    playerAdapter.ensurePlayer()
    playerAdapter.setEventHandler { [weak self] event in
      guard let self else { return }
      Task {
        await self.handlePlayerEvent(event)
      }
    }

    audioSessionController.registerObserversIfNeeded { [weak self] event in
      guard let self else { return }
      Task {
        await self.handleAudioSessionEvent(event)
      }
    }

    remoteCommandController.registerIfNeeded { [weak self] event in
      guard let self else { return }
      Task {
        await self.handleRemoteCommandEvent(event)
      }
    }

    registerAppLifecycleObserversIfNeeded(
      didBecomeActive: lifecycle.1,
      didEnterBackground: lifecycle.2
    )
    isAppInForeground = lifecycle.0

    isConfigured = true
  }

  private func registerAppLifecycleObserversIfNeeded(
    didBecomeActive: Notification.Name,
    didEnterBackground: Notification.Name
  ) {
    guard appDidBecomeActiveObserver == nil, appDidEnterBackgroundObserver == nil else {
      return
    }

    let center = NotificationCenter.default
    appDidBecomeActiveObserver = center.addObserver(
      forName: didBecomeActive,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      Task {
        await self.handleAppLifecycleChanged(isForeground: true)
      }
    }

    appDidEnterBackgroundObserver = center.addObserver(
      forName: didEnterBackground,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      Task {
        await self.handleAppLifecycleChanged(isForeground: false)
      }
    }
  }

  private func unregisterAppLifecycleObservers() {
    let center = NotificationCenter.default

    if let appDidBecomeActiveObserver {
      center.removeObserver(appDidBecomeActiveObserver)
      self.appDidBecomeActiveObserver = nil
    }

    if let appDidEnterBackgroundObserver {
      center.removeObserver(appDidEnterBackgroundObserver)
      self.appDidEnterBackgroundObserver = nil
    }
  }

  private func handleAppLifecycleChanged(isForeground: Bool) {
    isAppInForeground = isForeground
    emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: false, refreshArtwork: false)
  }

  private func handlePlayerEvent(_ event: PlayerEvent) {
    switch event {
    case let .timeControlChanged(sourceRevision):
      guard sourceRevision == machine.sourceRevision else { return }
      if playerAdapter.isActuallyPlaying(), machine.didReachEnd {
        machine.clearEnded()
      }
      emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: false, refreshArtwork: false)

    case let .itemStatusChanged(sourceRevision, status, error):
      guard sourceRevision == machine.sourceRevision else { return }
      switch status {
      case .readyToPlay:
        machine.clearError()
      case .failed:
        machine.markError(error ?? "failed to load audio source")
      case .unknown:
        break
      @unknown default:
        break
      }
      emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: false, refreshArtwork: false)

    case let .durationChanged(sourceRevision):
      guard sourceRevision == machine.sourceRevision else { return }
      emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: false, refreshArtwork: false)

    case let .progress(sourceRevision, _):
      guard sourceRevision == machine.sourceRevision else { return }
      // Ignore progress updates until the active seek revision commits at target.
      if let pendingSeek = machine.pendingSeek {
        if pendingSeek.sourceRevision == sourceRevision, hasSeekSettled(pendingSeek: pendingSeek, currentTime: playerAdapter.currentTimeSeconds()) {
          _ = machine.resolveSeek(sourceRevision: pendingSeek.sourceRevision, seekRevision: pendingSeek.revision)
          machine.clearError()
          emitState(trigger: .transition, forcePersistCheckpoint: true, forceEmit: true, refreshArtwork: false)
        }
        return
      }
      emitState(trigger: .progressTick, forcePersistCheckpoint: false, forceEmit: false, refreshArtwork: false)

    case let .didReachEnd(sourceRevision):
      guard sourceRevision == machine.sourceRevision else { return }
      if machine.pendingSeek != nil {
        return
      }
      machine.markEnded()
      emitState(trigger: .transition, forcePersistCheckpoint: true, forceEmit: true, refreshArtwork: false)

    case let .failedToEnd(sourceRevision, error):
      guard sourceRevision == machine.sourceRevision else { return }
      if machine.pendingSeek != nil {
        return
      }
      machine.markError(error ?? "failed to play audio")
      emitState(trigger: .transition, forcePersistCheckpoint: true, forceEmit: true, refreshArtwork: false)

    case let .seekCompleted(sourceRevision, seekRevision, finished, _):
      guard finished else {
        if machine.cancelSeek(sourceRevision: sourceRevision, seekRevision: seekRevision) {
          emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
        }
        return
      }
      guard let pendingSeek = machine.pendingSeek else {
        return
      }
      guard pendingSeek.sourceRevision == sourceRevision, pendingSeek.revision == seekRevision else {
        return
      }

      if pendingSeek.shouldResume && machine.desiredPlaying {
        playerAdapter.play(rate: machine.playbackRate)
      } else {
        playerAdapter.pause()
      }

      if !pendingSeek.shouldResume || hasSeekSettled(pendingSeek: pendingSeek, currentTime: playerAdapter.currentTimeSeconds()) {
        _ = machine.resolveSeek(sourceRevision: sourceRevision, seekRevision: seekRevision)
      }

      machine.clearError()
      emitState(trigger: .transition, forcePersistCheckpoint: true, forceEmit: true, refreshArtwork: false)
    }
  }

  private func handleAudioSessionEvent(_ event: AudioSessionEvent) async {
    switch event {
    case .interruptionBegan:
      wasPlayingBeforeInterruption = machine.desiredPlaying
      machine.clearPendingSeek()
      if wasPlayingBeforeInterruption {
        machine.setDesiredPlaying(false)
        playerAdapter.pause()
      }
      emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)

    case let .interruptionEnded(shouldResume):
      defer { wasPlayingBeforeInterruption = false }
      guard wasPlayingBeforeInterruption, shouldResume else {
        emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
        return
      }

      do {
        _ = try await play()
      } catch {
        machine.markError(error.localizedDescription)
        emitState(trigger: .transition, forcePersistCheckpoint: false, forceEmit: true, refreshArtwork: false)
      }

    case .oldDeviceUnavailable:
      machine.clearPendingSeek()
      machine.setDesiredPlaying(false)
      if playerAdapter.isActuallyPlaying() {
        playerAdapter.pause()
      }
      emitState(trigger: .transition, forcePersistCheckpoint: true, forceEmit: true, refreshArtwork: false)
    }
  }

  private func handleRemoteCommandEvent(_ event: RemoteCommandEvent) async {
    switch event {
    case .play:
      _ = try? await play()
    case .pause:
      _ = await pause()
    case .toggle:
      if machine.desiredPlaying {
        _ = await pause()
      } else {
        _ = try? await play()
      }
    case .next:
      _ = try? await skipQueue(by: 1)
    case .previous:
      _ = try? await skipQueue(by: -1)
    case .stop:
      _ = await stop()
    case let .seek(position):
      _ = await seekTo(position: position)
    case let .seekDelta(delta):
      let next = snapshot().currentTime + delta
      _ = await seekTo(position: next)
    }
  }

  private func snapshot() -> NativeAudioState {
    machine.makeSnapshot(
      rawCurrentTime: playerAdapter.currentTimeSeconds(),
      rawDuration: playerAdapter.durationSeconds(),
      isActuallyPlaying: playerAdapter.isActuallyPlaying(),
      isBuffering: playerAdapter.isBuffering()
    )
  }

  private func emitState(
    trigger: EmitTrigger,
    forcePersistCheckpoint: Bool,
    forceEmit: Bool,
    refreshArtwork: Bool
  ) {
    let state = snapshot()
    let now = Date()

    checkpointStore.persistIfNeeded(snapshot: state, storyId: machine.currentStoryId, force: forcePersistCheckpoint)

    let shouldEmit = forceEmit || shouldEmitState(state, trigger: trigger, now: now)
    if shouldEmit {
      if let emitter {
        if Thread.isMainThread {
          emitter.emitNativeAudioState(state)
        } else {
          DispatchQueue.main.sync {
            emitter.emitNativeAudioState(state)
          }
        }
      }
      lastEmittedState = state
      if trigger == .progressTick {
        lastProgressTickEmitAt = now
      }
    }

    let shouldUpdateNowPlaying = trigger != .progressTick || shouldEmit || forceEmit
    if shouldUpdateNowPlaying {
      nowPlayingController.update(state: state, metadata: machine.metadata, refreshArtwork: refreshArtwork)
    }
  }

  private func shouldEmitState(_ next: NativeAudioState, trigger: EmitTrigger, now: Date) -> Bool {
    guard let lastEmittedState else {
      return true
    }

    if trigger == .progressTick {
      if !next.isPlaying {
        return !isSameState(lhs: lastEmittedState, rhs: next)
      }
      let interval = isAppInForeground ? foregroundProgressEmitIntervalSeconds : backgroundProgressEmitIntervalSeconds
      return now.timeIntervalSince(lastProgressTickEmitAt) >= interval
    }

    return !isSameState(lhs: lastEmittedState, rhs: next)
  }

  private func isSameState(lhs: NativeAudioState, rhs: NativeAudioState) -> Bool {
    lhs.id == rhs.id
      && lhs.status == rhs.status
      && lhs.currentTime == rhs.currentTime
      && lhs.duration == rhs.duration
      && lhs.isPlaying == rhs.isPlaying
      && lhs.buffering == rhs.buffering
      && lhs.rate == rhs.rate
      && lhs.error == rhs.error
  }

  private func hasSeekSettled(pendingSeek: PendingSeekContext, currentTime: Double) -> Bool {
    let direction = pendingSeek.targetPosition - pendingSeek.originPosition
    if direction > 0 {
      return currentTime + seekCommitEpsilonSeconds >= pendingSeek.targetPosition
    }
    if direction < 0 {
      return currentTime - seekCommitEpsilonSeconds <= pendingSeek.targetPosition
    }
    return abs(currentTime - pendingSeek.targetPosition) <= seekCommitEpsilonSeconds
  }

}
