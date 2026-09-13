import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:handrail_ai_widgets/handrail_ai_widgets.dart';

typedef _Result = ({String? text, String? errorCode, bool retryable});
const _success = (text: 'dictated words', errorCode: null, retryable: false);

Widget subject(TextEditingController draft, _Recorder recorder,
        HandrailAudioTranscriber transcribe,
        {Object scope = 'one', int? maxLength, VoidCallback? onSend}) =>
    MaterialApp(
        home: Scaffold(
            body: HandrailComposer(
      controller: draft,
      inputKey: const ValueKey('draft'),
      sendKey: const ValueKey('send'),
      showAttachmentControl: false,
      showApprovalControl: false,
      transcribeAudio: transcribe,
      transcriptionScope: scope,
      transcriptionMaxDraftLength: maxLength,
      audioRecorderFactory: () => recorder,
      canSend: true,
      onSend: onSend ?? () {},
    )));

Future<void> recordAndStop(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Dictate a message'));
  await tester.pump();
  await tester.tap(find.byTooltip('Stop recording and transcribe'));
  await tester.pump();
}

void main() {
  testWidgets(
      'authenticated dictation keeps typing editable, inserts latest text and never sends',
      (tester) async {
    final draft = TextEditingController(text: 'first');
    addTearDown(draft.dispose);
    final recorder = _Recorder();
    final response = Completer<_Result>();
    var sent = 0, requests = 0;
    await tester.pumpWidget(subject(draft, recorder, (
        {required bytes,
        required mediaType,
        required duration,
        required idempotencyKey,
        required cancellation}) {
      requests++;
      expect(bytes.length, greaterThan(44));
      expect(idempotencyKey, startsWith('mic:'));
      return response.future;
    }, onSend: () => sent++));
    await recordAndStop(tester);
    expect(
        tester.widget<IconButton>(find.byKey(const ValueKey('send'))).onPressed,
        isNull);
    expect(
        tester.widget<TextField>(find.byKey(const ValueKey('draft'))).enabled,
        isTrue);
    await tester.enterText(
        find.byKey(const ValueKey('draft')), 'edited while transcribing');
    response.complete(_success);
    await tester.pumpAndSettle();
    expect(draft.text, 'edited while transcribing dictated words');
    expect(sent, 0);
    expect(requests, 1);
    expect(recorder.disposed, isTrue);
    expect(recorder.recording?.byteSize, 0);
  });

  testWidgets(
      'retry retains capture identity and bytes; draft-limit retry avoids another request',
      (tester) async {
    final draft = TextEditingController(text: 'this is too long');
    addTearDown(draft.dispose);
    final recorder = _Recorder();
    final calls = <({String key, List<int> bytes})>[];
    await tester.pumpWidget(subject(draft, recorder, (
        {required bytes,
        required mediaType,
        required duration,
        required idempotencyKey,
        required cancellation}) async {
      calls.add((key: idempotencyKey, bytes: List.of(bytes)));
      return calls.length == 1
          ? (text: null, errorCode: 'service_unavailable', retryable: true)
          : _success;
    }, maxLength: 20));
    await recordAndStop(tester);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Retry transcription'));
    await tester.pumpAndSettle();
    expect(calls, hasLength(2));
    expect(calls[0].key, calls[1].key);
    expect(calls[0].bytes, calls[1].bytes);
    expect(draft.text, 'this is too long');
    expect(find.byTooltip('Insert saved dictation'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('draft')), 'now');
    await tester.tap(find.byTooltip('Insert saved dictation'));
    await tester.pumpAndSettle();
    expect(draft.text, 'now dictated words');
    expect(calls, hasLength(2));
    expect(recorder.recording?.byteSize, 0);
  });

  testWidgets(
      'uncertain outcomes cannot retry even if a host marks them retryable',
      (tester) async {
    final draft = TextEditingController(text: 'keep');
    addTearDown(draft.dispose);
    final recorder = _Recorder();
    await tester.pumpWidget(subject(
        draft,
        recorder,
        (
                {required bytes,
                required mediaType,
                required duration,
                required idempotencyKey,
                required cancellation}) async =>
            (text: null, errorCode: 'outcome_unknown', retryable: true)));
    await recordAndStop(tester);
    await tester.pumpAndSettle();
    expect(find.byTooltip('Retry transcription'), findsNothing);
    expect(find.byTooltip('Dictate a message'), findsOneWidget);
    expect(draft.text, 'keep');
    expect(recorder.recording?.byteSize, 0);
  });

  for (final change in ['scope', 'dispose', 'cancel']) {
    testWidgets('$change cancels observation and excludes late draft insertion',
        (tester) async {
      final draft = TextEditingController(text: 'keep');
      addTearDown(draft.dispose);
      final recorder = _Recorder();
      final response = Completer<_Result>();
      var cancelled = false;
      Future<_Result> transcribe(
          {required List<int> bytes,
          required String mediaType,
          required Duration duration,
          required String idempotencyKey,
          required Future<void> cancellation}) {
        unawaited(cancellation.then((_) => cancelled = true));
        return response.future;
      }

      await tester.pumpWidget(subject(draft, recorder, transcribe));
      await recordAndStop(tester);
      if (change == 'scope') {
        await tester
            .pumpWidget(subject(draft, _Recorder(), transcribe, scope: 'two'));
      } else if (change == 'dispose') {
        await tester.pumpWidget(const SizedBox());
      } else {
        await tester.tap(find.byTooltip('Discard recording'));
      }
      await tester.pump();
      expect(cancelled, isTrue);
      response.complete(_success);
      await tester.pumpAndSettle();
      expect(draft.text, 'keep');
      expect(recorder.recording?.byteSize, 0);
      expect(tester.takeException(), isNull);
    });
  }
}

class _Recorder implements HandrailAudioRecorder {
  bool disposed = false;
  HandrailAudioRecording? recording;
  @override
  Future<void> start() async {}
  @override
  Future<HandrailAudioRecording> stop() async {
    final bytes = Uint8List(364);
    bytes.setRange(0, 4, [82, 73, 70, 70]);
    bytes.setRange(8, 12, [87, 65, 86, 69]);
    return recording = HandrailAudioRecording.wav(
        bytes: bytes, duration: const Duration(milliseconds: 10));
  }

  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {
    disposed = true;
  }
}
