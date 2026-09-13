import 'dart:async';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:handrail_ai_widgets/handrail_ai_widgets.dart';
import 'package:record/record.dart';

void main() {
  test('a platform startup failure releases any partially opened microphone',
      () async {
    final backend = _Recorder()..failStart = true;
    final recorder = HandrailPcmAudioRecorder(recorder: backend);
    addTearDown(recorder.dispose);
    await expectLater(
        recorder.start(), throwsA(isA<HandrailAudioRecordingFailure>()));
    expect(backend.cancelled, 1);
  });
  test('bounded PCM becomes a WAV with its real duration and clearable bytes',
      () async {
    final backend = _Recorder();
    final recorder =
        HandrailPcmAudioRecorder(recorder: backend, maximumBytes: 364);
    addTearDown(recorder.dispose);
    await recorder.start();
    final input = Uint8List.fromList(List.filled(640, 12));
    backend.stream.add(input);
    input.fillRange(0, input.length, 0);
    await Future<void>.delayed(Duration.zero);
    final result = await recorder.stop();
    expect(result.duration, const Duration(milliseconds: 10));
    expect(result.byteSize, 364);
    expect(result.copyBytes().sublist(44), List.filled(320, 12));
    expect(backend.stops, 1);
    result.clear();
    expect(result.byteSize, 0);
    expect(result.copyBytes, throwsStateError);
  });

  test(
      'duplicate Start is rejected and cancellation prevents late permission capture',
      () async {
    final permission = Completer<bool>();
    final backend = _Recorder()..permission = permission.future;
    final recorder = HandrailPcmAudioRecorder(recorder: backend);
    addTearDown(recorder.dispose);
    final first = recorder.start();
    final error =
        expectLater(first, throwsA(isA<HandrailAudioRecordingFailure>()));
    await expectLater(
        recorder.start(), throwsA(isA<HandrailAudioRecordingFailure>()));
    final cancellation = recorder.cancel();
    permission.complete(true);
    await cancellation;
    await error;
    expect(backend.starts, 0);
  });

  test('disposing during platform start closes the late microphone stream',
      () async {
    final release = Completer<Stream<Uint8List>>();
    final backend = _Recorder()..starting = release.future;
    final recorder = HandrailPcmAudioRecorder(recorder: backend);
    final first = recorder.start();
    await Future<void>.delayed(Duration.zero);
    final failure =
        expectLater(first, throwsA(isA<HandrailAudioRecordingFailure>()));
    final closing = recorder.dispose();
    release.complete(backend.stream.stream);
    await closing;
    await failure;
    expect(backend.cancelled, greaterThanOrEqualTo(1));
    expect(backend.disposed, isTrue);
    expect(backend.stream.hasListener, isFalse);
  });

  test('permission denial does not start capture and empty audio is rejected',
      () async {
    final backend = _Recorder()..permission = Future.value(false);
    final recorder = HandrailPcmAudioRecorder(recorder: backend);
    addTearDown(recorder.dispose);
    await expectLater(
        recorder.start(),
        throwsA(isA<HandrailAudioRecordingFailure>().having(
            (error) => error.kind,
            'kind',
            HandrailAudioRecordingFailureKind.permissionDenied)));
    expect(backend.starts, 0);
    backend.permission = Future.value(true);
    await recorder.start();
    await expectLater(
        recorder.stop(),
        throwsA(isA<HandrailAudioRecordingFailure>().having(
            (error) => error.kind,
            'kind',
            HandrailAudioRecordingFailureKind.empty)));
  });
}

class _Recorder implements AudioRecorder {
  final stream = StreamController<Uint8List>(sync: true);
  Future<bool> permission = Future.value(true);
  Future<Stream<Uint8List>>? starting;
  int starts = 0, stops = 0, cancelled = 0;
  bool disposed = false;
  bool failStart = false;
  @override
  Future<bool> hasPermission({bool request = true}) => permission;
  @override
  Future<Stream<Uint8List>> startStream(RecordConfig config) async {
    starts++;
    if (failStart) throw StateError('Platform startup failed');
    expect(config.encoder, AudioEncoder.pcm16bits);
    expect(config.sampleRate, 16000);
    return starting ?? stream.stream;
  }

  @override
  Future<String?> stop() async {
    stops++;
    unawaited(stream.close());
    return null;
  }

  @override
  Future<void> cancel() async {
    cancelled++;
    unawaited(stream.close());
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    unawaited(stream.close());
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
