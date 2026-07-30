import Foundation
import ImageIO
import MediaPlayer
import UIKit

private let fallbackNowPlayingTitle = "KDJ"
private let maxArtworkBytes = 16 * 1024 * 1024
private let maxArtworkEdge: CGFloat = 1024

final class NowPlayingController {
  private var nowPlayingArtwork: MPMediaItemArtwork?
  private var loadedArtworkURL: String?
  private var artworkTaskId = UUID()

  func update(state: NativeAudioState, metadata: PlaybackMetadata, refreshArtwork: Bool = false) {
    onMain {
      if refreshArtwork {
        fetchArtworkIfNeeded(rawURL: metadata.artworkURL)
      }

      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]

      if let title = metadata.title, !title.isEmpty {
        info[MPMediaItemPropertyTitle] = title
      } else {
        info[MPMediaItemPropertyTitle] = fallbackNowPlayingTitle
      }

      if let artist = metadata.artist, !artist.isEmpty {
        info[MPMediaItemPropertyArtist] = artist
      } else {
        info.removeValue(forKey: MPMediaItemPropertyArtist)
      }

      if let album = metadata.album, !album.isEmpty {
        info[MPMediaItemPropertyAlbumTitle] = album
      } else {
        info.removeValue(forKey: MPMediaItemPropertyAlbumTitle)
      }

      if state.duration > 0 {
        info[MPMediaItemPropertyPlaybackDuration] = state.duration
      } else {
        info.removeValue(forKey: MPMediaItemPropertyPlaybackDuration)
      }

      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = state.currentTime
      info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = state.rate
      info[MPNowPlayingInfoPropertyPlaybackRate] = state.isPlaying ? state.rate : 0.0
      info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue

      if let nowPlayingArtwork {
        info[MPMediaItemPropertyArtwork] = nowPlayingArtwork
      } else {
        info.removeValue(forKey: MPMediaItemPropertyArtwork)
      }

      let center = MPNowPlayingInfoCenter.default()
      center.nowPlayingInfo = info
      center.playbackState = playbackState(for: state)
    }
  }

  func clear() {
    onMain {
      artworkTaskId = UUID()
      nowPlayingArtwork = nil
      loadedArtworkURL = nil
      let center = MPNowPlayingInfoCenter.default()
      center.nowPlayingInfo = nil
      center.playbackState = .stopped
    }
  }

  private func fetchArtworkIfNeeded(rawURL: String?) {
    guard let rawURL = rawURL?.trimmingCharacters(in: .whitespacesAndNewlines), !rawURL.isEmpty else {
      nowPlayingArtwork = nil
      loadedArtworkURL = nil
      return
    }

    if rawURL == loadedArtworkURL, nowPlayingArtwork != nil {
      return
    }

    guard let url = URL(string: rawURL) else {
      nowPlayingArtwork = nil
      loadedArtworkURL = nil
      return
    }

    nowPlayingArtwork = nil
    loadedArtworkURL = nil

    let taskId = UUID()
    artworkTaskId = taskId

    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      guard let image = Self.loadArtworkImage(from: url) else { return }
      DispatchQueue.main.async {
        guard self.artworkTaskId == taskId else { return }
        self.nowPlayingArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        self.loadedArtworkURL = rawURL

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyArtwork] = self.nowPlayingArtwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      }
    }
  }

  private static func loadArtworkImage(from url: URL) -> UIImage? {
    let data: Data?
    if url.isFileURL {
      data = try? Data(contentsOf: url)
    } else {
      data = try? Data(contentsOf: url, options: [.mappedIfSafe])
    }
    guard let data, data.count <= maxArtworkBytes else {
      return nil
    }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
      return nil
    }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxArtworkEdge,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      return nil
    }
    return UIImage(cgImage: image)
  }

  private func playbackState(for state: NativeAudioState) -> MPNowPlayingPlaybackState {
    if state.status == "ended" || state.status == "error" {
      return .stopped
    }
    if state.isPlaying {
      return .playing
    }
    return .paused
  }

  private func onMain<T>(_ block: () -> T) -> T {
    if Thread.isMainThread {
      return block()
    }
    return DispatchQueue.main.sync(execute: block)
  }
}
