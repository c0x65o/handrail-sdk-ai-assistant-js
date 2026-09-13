import 'dart:async';
import 'dart:typed_data';
import 'dart:math' as math;

import 'package:record/record.dart';

const Duration maxHandrailVoiceRecordingDuration = Duration(seconds: 60);

enum HandrailAudioRecordingFailureKind {
  permissionDenied,
  unavailable,
  empty,
  tooLarge,
}

final class HandrailAudioRecordingFailure implements Exception {
  const HandrailAudioRecordingFailure(this.kind);

  final HandrailAudioRecordingFailureKind kind;

  @override
  String toString() => 'HandrailAudioRecordingFailure(${kind.name})';
}

final class HandrailAudioRecording {
  HandrailAudioRecording._({
    required this.mediaType,
    required this.duration,
    required Uint8List bytes,
  }) : _bytes = bytes;

  factory HandrailAudioRecording.wav({
    required Uint8List bytes,
    required Duration duration,
  }) {
    if (bytes.length < 44 ||
        bytes[0] != 0x52 ||
        bytes[1] != 0x49 ||
        bytes[2] != 0x46 ||
        bytes[3] != 0x46 ||
        bytes[8] != 0x57 ||
        bytes[9] != 0x41 ||
        bytes[10] != 0x56 ||
        bytes[11] != 0x45) {
      throw ArgumentError('A valid WAV recording is required.');
    }
    return HandrailAudioRecording._(
      mediaType: 'audio/wav',
      duration: duration,
      bytes: Uint8List.fromList(bytes),
    );
  }

  final String mediaType;
  final Duration duration;
  Uint8List? _bytes;

  int get byteSize => _bytes?.length ?? 0;

  Uint8List copyBytes() {
    final Uint8List? bytes = _bytes;
    if (bytes == null) {
      throw StateError('The protected recording has been cleared.');
    }
    return Uint8List.fromList(bytes);
  }

  void clear() {
    _bytes?.fillRange(0, _bytes!.length, 0);
    _bytes = null;
  }

  @override
  String toString() {
    return 'HandrailAudioRecording(mediaType: $mediaType, '
        'durationMs: ${duration.inMilliseconds}, byteSize: $byteSize)';
  }
}

abstract interface class HandrailAudioRecorder {
  Future<void> start();

  Future<HandrailAudioRecording> stop();

  Future<void> cancel();

  Future<void> dispose();
}

/// Native/web microphone boundary that captures mono PCM and wraps it in a
/// deterministic WAV container accepted by the primary API.
final class HandrailPcmAudioRecorder implements HandrailAudioRecorder {
  HandrailPcmAudioRecorder({
    AudioRecorder? recorder,
    this.maximumDuration = maxHandrailVoiceRecordingDuration,
    this.maximumBytes = 25 * 1024 * 1024,
  }) : _recorder = recorder ?? AudioRecorder() {
    if (maximumDuration <= Duration.zero ||
        maximumDuration > const Duration(hours: 1) ||
        maximumBytes < 46 ||
        maximumBytes > 25 * 1024 * 1024) {
      throw ArgumentError('Invalid microphone limits.');
    }
  }

  final Duration maximumDuration;
  final int maximumBytes;
  final AudioRecorder _recorder;
  static const _sampleRate = 16000;
  static const _bytesPerSecond = _sampleRate * 2;
  int get _maximumPcmBytes =>
      math.min(
          maximumBytes - 44,
          maximumDuration.inMicroseconds *
              _bytesPerSecond ~/
              Duration.microsecondsPerSecond) ~/
      2 *
      2;
  StreamSubscription<Uint8List>? _subscription;
  Completer<void>? _streamDone;
  BytesBuilder? _pcmBytes;
  Future<void>? _starting, _cancelling, _hardwareStop;
  Future<HandrailAudioRecording>? _stopping;
  Timer? _limitTimer;
  int _generation = 0;
  bool _streamFailed = false, _disposed = false;

  static const _unavailable = HandrailAudioRecordingFailure(
      HandrailAudioRecordingFailureKind.unavailable);

  void _assertCurrent(int generation) {
    if (_disposed || generation != _generation) throw _unavailable;
  }

  @override
  Future<void> start() {
    if (_disposed ||
        _starting != null ||
        _cancelling != null ||
        _stopping != null ||
        _subscription != null) return Future.error(_unavailable);
    final generation = ++_generation;
    return _starting = _start(generation).whenComplete(() {
      _starting = null;
    });
  }

  Future<void> _start(int generation) async {
    var requestedCapture = false;
    try {
      final permitted = await _recorder.hasPermission();
      _assertCurrent(generation);
      if (!permitted)
        throw const HandrailAudioRecordingFailure(
            HandrailAudioRecordingFailureKind.permissionDenied);
      requestedCapture = true;
      final stream = await _recorder.startStream(const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: _sampleRate,
          numChannels: 1,
          autoGain: true,
          echoCancel: true,
          noiseSuppress: true));
      if (_disposed || generation != _generation) {
        await _recorder.cancel();
        await stream.listen((_) {}).cancel();
        throw _unavailable;
      }
      _pcmBytes = BytesBuilder(copy: false);
      _streamDone = Completer<void>();
      _streamFailed = false;
      _hardwareStop = null;
      _subscription = stream.listen((chunk) {
        final buffer = _pcmBytes;
        if (generation != _generation || buffer == null || chunk.isEmpty)
          return;
        final remaining = _maximumPcmBytes - buffer.length;
        if (remaining > 0)
          buffer.add(Uint8List.fromList(
              chunk.length <= remaining ? chunk : chunk.sublist(0, remaining)));
        if (buffer.length >= _maximumPcmBytes) unawaited(_stopHardware());
      }, onError: (Object _) {
        if (generation != _generation) return;
        _streamFailed = true;
        if (!(_streamDone?.isCompleted ?? true)) _streamDone!.complete();
        unawaited(_stopHardware());
      }, onDone: () {
        if (generation == _generation && !(_streamDone?.isCompleted ?? true)) {
          _streamDone!.complete();
        }
      });
      _limitTimer = Timer(maximumDuration, () => unawaited(_stopHardware()));
    } on HandrailAudioRecordingFailure {
      rethrow;
    } catch (_) {
      if (requestedCapture) {
        try {
          await _recorder.cancel();
        } catch (_) {/* Release partial startup. */}
        if (generation == _generation) _resetCapture();
      }
      throw _unavailable;
    }
  }

  Future<void> _stopHardware() => _hardwareStop ??= () async {
        final generation = _generation;
        try {
          await _recorder.stop();
        } catch (_) {
          if (generation == _generation) _streamFailed = true;
        }
      }();

  @override
  Future<HandrailAudioRecording> stop() {
    if (_disposed || _starting != null || _cancelling != null)
      return Future.error(_unavailable);
    return _stopping ??= _stop(_generation).whenComplete(() {
      _stopping = null;
    });
  }

  Future<HandrailAudioRecording> _stop(int generation) async {
    final subscription = _subscription;
    final streamDone = _streamDone;
    final pcm = _pcmBytes;
    if (subscription == null || streamDone == null || pcm == null)
      throw _unavailable;
    try {
      _limitTimer?.cancel();
      await _stopHardware();
      _assertCurrent(generation);
      if (!streamDone.isCompleted)
        await streamDone.future.timeout(const Duration(seconds: 2));
      await subscription.cancel();
      _assertCurrent(generation);
      if (_streamFailed) throw _unavailable;
      var raw = pcm.takeBytes();
      if (raw.length.isOdd) raw = Uint8List.sublistView(raw, 0, raw.length - 1);
      if (raw.isEmpty)
        throw const HandrailAudioRecordingFailure(
            HandrailAudioRecordingFailureKind.empty);
      final wav = _wavFromPcm(raw);
      final duration = Duration(
          microseconds:
              raw.length * Duration.microsecondsPerSecond ~/ _bytesPerSecond);
      raw.fillRange(0, raw.length, 0);
      try {
        return HandrailAudioRecording.wav(bytes: wav, duration: duration);
      } finally {
        wav.fillRange(0, wav.length, 0);
      }
    } on HandrailAudioRecordingFailure {
      rethrow;
    } catch (_) {
      throw _unavailable;
    } finally {
      if (generation == _generation) _resetCapture();
    }
  }

  @override
  Future<void> cancel() => _cancelling ??= _cancel().whenComplete(() {
        _cancelling = null;
      });

  Future<void> _cancel() async {
    ++_generation;
    _limitTimer?.cancel();
    try {
      try {
        await _starting;
      } catch (_) {/* The invalidated start cannot resume. */}
      try {
        await _stopping;
      } catch (_) {/* Stop owns no new draft. */}
      await _hardwareStop;
      await _recorder.cancel();
      await _subscription?.cancel();
    } catch (_) {/* Do not expose device errors. */} finally {
      _resetCapture();
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await cancel();
    await _recorder.dispose();
  }

  void _resetCapture() {
    _limitTimer?.cancel();
    _limitTimer = null;
    final remaining = _pcmBytes?.takeBytes();
    remaining?.fillRange(0, remaining.length, 0);
    _subscription = null;
    _streamDone = null;
    _pcmBytes = null;
    _hardwareStop = null;
    _streamFailed = false;
  }
}

Uint8List _wavFromPcm(Uint8List pcm) {
  final Uint8List wav = Uint8List(44 + pcm.length);
  final ByteData header = ByteData.sublistView(wav, 0, 44);

  void ascii(int offset, String value) {
    for (var index = 0; index < value.length; index += 1) {
      wav[offset + index] = value.codeUnitAt(index);
    }
  }

  const int bytesPerSample = 2;
  const int byteRate = 16000 * bytesPerSample;
  ascii(0, 'RIFF');
  header.setUint32(4, 36 + pcm.length, Endian.little);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  header.setUint32(16, 16, Endian.little);
  header.setUint16(20, 1, Endian.little);
  header.setUint16(22, 1, Endian.little);
  header.setUint32(24, 16000, Endian.little);
  header.setUint32(28, byteRate, Endian.little);
  header.setUint16(32, bytesPerSample, Endian.little);
  header.setUint16(34, 16, Endian.little);
  ascii(36, 'data');
  header.setUint32(40, pcm.length, Endian.little);
  wav.setRange(44, wav.length, pcm);
  return wav;
}
