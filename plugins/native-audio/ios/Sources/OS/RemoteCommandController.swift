import Foundation
import MediaPlayer

enum RemoteCommandEvent: Sendable {
  case play
  case pause
  case toggle
  case next
  case previous
  case stop
  case seek(position: Double)
  case seekDelta(delta: Double)
}

final class RemoteCommandController {
  private var remoteCommandTargets: [(MPRemoteCommand, Any)] = []
  private var eventHandler: ((RemoteCommandEvent) -> Void)?

  deinit {
    unregister()
  }

  func registerIfNeeded(eventHandler: @escaping (RemoteCommandEvent) -> Void) {
    onMain {
      self.eventHandler = eventHandler
      if !remoteCommandTargets.isEmpty {
        return
      }

      let center = MPRemoteCommandCenter.shared()
      center.playCommand.isEnabled = true
      center.pauseCommand.isEnabled = true
      center.togglePlayPauseCommand.isEnabled = true
      center.nextTrackCommand.isEnabled = true
      center.previousTrackCommand.isEnabled = true
      center.stopCommand.isEnabled = true
      center.changePlaybackPositionCommand.isEnabled = true
      center.skipForwardCommand.isEnabled = true
      center.skipBackwardCommand.isEnabled = true
      center.skipForwardCommand.preferredIntervals = [NSNumber(value: remoteSeekStepSeconds)]
      center.skipBackwardCommand.preferredIntervals = [NSNumber(value: remoteSeekStepSeconds)]

      let playTarget = center.playCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.play)
        return .success
      }
      remoteCommandTargets.append((center.playCommand, playTarget))

      let pauseTarget = center.pauseCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.pause)
        return .success
      }
      remoteCommandTargets.append((center.pauseCommand, pauseTarget))

      let toggleTarget = center.togglePlayPauseCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.toggle)
        return .success
      }
      remoteCommandTargets.append((center.togglePlayPauseCommand, toggleTarget))

      let nextTarget = center.nextTrackCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.next)
        return .success
      }
      remoteCommandTargets.append((center.nextTrackCommand, nextTarget))

      let previousTarget = center.previousTrackCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.previous)
        return .success
      }
      remoteCommandTargets.append((center.previousTrackCommand, previousTarget))

      let stopTarget = center.stopCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.stop)
        return .success
      }
      remoteCommandTargets.append((center.stopCommand, stopTarget))

      let changePositionTarget = center.changePlaybackPositionCommand.addTarget { [weak self] event in
        guard let seekEvent = event as? MPChangePlaybackPositionCommandEvent else {
          return .commandFailed
        }
        self?.eventHandler?(.seek(position: seekEvent.positionTime))
        return .success
      }
      remoteCommandTargets.append((center.changePlaybackPositionCommand, changePositionTarget))

      let skipForwardTarget = center.skipForwardCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.seekDelta(delta: remoteSeekStepSeconds))
        return .success
      }
      remoteCommandTargets.append((center.skipForwardCommand, skipForwardTarget))

      let skipBackwardTarget = center.skipBackwardCommand.addTarget { [weak self] _ in
        self?.eventHandler?(.seekDelta(delta: -remoteSeekStepSeconds))
        return .success
      }
      remoteCommandTargets.append((center.skipBackwardCommand, skipBackwardTarget))
    }
  }

  func unregister() {
    onMain {
      let center = MPRemoteCommandCenter.shared()

      for (command, target) in remoteCommandTargets {
        command.removeTarget(target)
      }
      remoteCommandTargets.removeAll()
      eventHandler = nil

      center.playCommand.isEnabled = false
      center.pauseCommand.isEnabled = false
      center.togglePlayPauseCommand.isEnabled = false
      center.nextTrackCommand.isEnabled = false
      center.previousTrackCommand.isEnabled = false
      center.stopCommand.isEnabled = false
      center.changePlaybackPositionCommand.isEnabled = false
      center.skipForwardCommand.isEnabled = false
      center.skipBackwardCommand.isEnabled = false
    }
  }

  private func onMain<T>(_ block: () -> T) -> T {
    if Thread.isMainThread {
      return block()
    }
    return DispatchQueue.main.sync(execute: block)
  }
}
