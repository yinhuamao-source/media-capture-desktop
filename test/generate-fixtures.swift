// Regenerate the tiny, original media fixtures on macOS: swift test/generate-fixtures.swift
import Foundation
import AVFoundation
import AppKit

let directory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("test/fixtures")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let videoURL = directory.appendingPathComponent("clip.mp4")
if FileManager.default.fileExists(atPath: videoURL.path) { try FileManager.default.removeItem(at: videoURL) }
let width = 320, height = 180
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32)!
for y in 0..<height { for x in 0..<width {
    let p = bitmap.bitmapData!.advanced(by: y * bitmap.bytesPerRow + x * 4)
    p[0] = UInt8(40 + x / 3); p[1] = UInt8(130 + y / 4); p[2] = 130; p[3] = 255
} }
try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("image.png"))
let writer = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
writer.movieFragmentInterval = CMTime(value: 1, timescale: 1)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
for frame in 0..<24 {
    while !input.isReadyForMoreMediaData { usleep(1000) }
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32ARGB, nil, &buffer)
    let pixel = buffer!
    CVPixelBufferLockBaseAddress(pixel, [])
    let data = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(pixel)
    for y in 0..<height { for x in 0..<width {
        let p = data.advanced(by: y * stride + x * 4)
        p[0] = 255; p[1] = UInt8(40 + frame * 5); p[2] = UInt8(130 + y / 4); p[3] = UInt8(80 + x / 3)
    } }
    CVPixelBufferUnlockBaseAddress(pixel, [])
    guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 12)) else { fatalError("append failed: \(String(describing: writer.error))") }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fatalError("write failed: \(String(describing: writer.error))") }
print("Generated original PNG and 2-second H.264 MP4 fixtures.")
