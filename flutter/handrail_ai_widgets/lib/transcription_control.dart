import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'audio_recorder.dart';

typedef HandrailAudioTranscriber
    = Future<({String? text, String? errorCode, bool retryable})> Function(
        {required List<int> bytes,
        required String mediaType,
        required Duration duration,
        required String idempotencyKey,
        required Future<void> cancellation});

/// Capture, authenticated transcription, retained retry and draft insertion.
/// The callback should delegate directly to HandrailAiClient.transcribeAudioResult.
class HandrailTranscriptionControl extends StatefulWidget {
  const HandrailTranscriptionControl(
      {super.key,
      required this.controller,
      required this.transcribe,
      this.scope,
      this.enabled = true,
      this.maximumDuration = maxHandrailVoiceRecordingDuration,
      this.maximumBytes = 25 * 1024 * 1024,
      this.maxDraftLength,
      this.recorderFactory,
      this.onChanged,
      this.onBusyChanged,
      this.createId});
  final TextEditingController controller;
  final HandrailAudioTranscriber transcribe;
  final Object? scope;
  final bool enabled;
  final Duration maximumDuration;
  final int maximumBytes;
  final int? maxDraftLength;
  final HandrailAudioRecorder Function()? recorderFactory;
  final ValueChanged<String>? onChanged;
  final ValueChanged<bool>? onBusyChanged;
  final String Function()? createId;
  @override
  State<HandrailTranscriptionControl> createState() =>
      _HandrailTranscriptionControlState();
}

enum _Phase { idle, starting, recording, transcribing, failed }

class _HandrailTranscriptionControlState
    extends State<HandrailTranscriptionControl> with WidgetsBindingObserver {
  _Phase _phase = _Phase.idle;
  HandrailAudioRecorder? _recorder;
  HandrailAudioRecording? _recording;
  Completer<void>? _abort;
  Timer? _timer;
  int _generation = 0;
  String? _operationId, _transcript, _error;
  bool _retryable = false;
  bool get _busy => const {
        _Phase.starting,
        _Phase.recording,
        _Phase.transcribing
      }.contains(_phase);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  void _phaseChanged(_Phase phase) {
    if (!mounted) return;
    final wasBusy = _busy;
    setState(() => _phase = phase);
    if (_busy != wasBusy) widget.onBusyChanged?.call(_busy);
  }

  void _release() {
    _generation++;
    _timer?.cancel();
    _timer = null;
    if (!(_abort?.isCompleted ?? true)) _abort!.complete();
    _abort = null;
    _recording?.clear();
    _recording = null;
    _transcript = null;
    _operationId = null;
    _error = null;
    _retryable = false;
    final recorder = _recorder;
    _recorder = null;
    if (recorder != null)
      unawaited(recorder.dispose().catchError((Object _) {}));
  }

  void _cancel() {
    _release();
    _phaseChanged(_Phase.idle);
  }

  @override
  void didUpdateWidget(HandrailTranscriptionControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.scope != widget.scope ||
        oldWidget.enabled && !widget.enabled ||
        oldWidget.maximumBytes != widget.maximumBytes ||
        oldWidget.maximumDuration != widget.maximumDuration) {
      final wasBusy = _busy;
      _release();
      _phase = _Phase.idle;
      final generation = _generation;
      if (wasBusy)
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && generation == _generation && !_busy)
            widget.onBusyChanged?.call(false);
        });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed && _phase != _Phase.idle) _cancel();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _release();
    super.dispose();
  }

  bool _current(int generation) =>
      mounted && generation == _generation && widget.enabled;

  Future<void> _start() async {
    if (!widget.enabled || _busy) return;
    _release();
    final generation = _generation;
    _phaseChanged(_Phase.starting);
    try {
      _operationId = widget.createId?.call() ??
          'mic:${DateTime.now().microsecondsSinceEpoch}:'
              '${List.generate(16, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
      final recorder = _recorder = widget.recorderFactory?.call() ??
          HandrailPcmAudioRecorder(
              maximumDuration: widget.maximumDuration,
              maximumBytes: widget.maximumBytes);
      await recorder.start();
      if (!_current(generation)) return;
      _phaseChanged(_Phase.recording);
      // WAV is 16 kHz mono PCM16 plus a 44-byte header. Observe both negotiated limits.
      final duration = Duration(
          microseconds: min(
              widget.maximumDuration.inMicroseconds,
              max(1, widget.maximumBytes - 44) *
                  Duration.microsecondsPerSecond ~/
                  32000));
      _timer = Timer(duration, () => unawaited(_stop()));
    } on HandrailAudioRecordingFailure catch (error) {
      if (_current(generation))
        _fail(
            error.kind == HandrailAudioRecordingFailureKind.permissionDenied
                ? 'permission_denied'
                : 'capture_failed',
            retryable: false);
    } catch (_) {
      if (_current(generation)) _fail('capture_failed', retryable: false);
    }
  }

  Future<void> _stop() async {
    if (!widget.enabled || _phase != _Phase.recording) return;
    final generation = _generation;
    final recorder = _recorder!;
    _timer?.cancel();
    _phaseChanged(_Phase.transcribing);
    try {
      final recording = await recorder.stop();
      if (!_current(generation)) {
        recording.clear();
        return;
      }
      _recording = recording;
      _recorder = null;
      await recorder.dispose();
      if (_current(generation)) await _transcribe(generation);
    } catch (_) {
      if (_current(generation)) _fail('capture_failed', retryable: false);
    }
  }

  Future<void> _transcribe(int generation) async {
    final recording = _recording;
    if (recording == null || !_current(generation)) return;
    _phaseChanged(_Phase.transcribing);
    final abort = _abort = Completer<void>();
    final bytes = recording.copyBytes();
    try {
      final result = await widget.transcribe(
          bytes: bytes,
          mediaType: recording.mediaType,
          duration: recording.duration,
          idempotencyKey: _operationId!,
          cancellation: abort.future);
      if (!_current(generation) || !identical(_abort, abort)) return;
      if (result.errorCode != null) {
        _fail(result.errorCode!,
            retryable: result.retryable &&
                const {
                  'deadline_exceeded',
                  'rate_limited',
                  'service_unavailable'
                }.contains(result.errorCode));
        return;
      }
      final text = result.text?.trim();
      if (text == null || text.isEmpty || text.length > 20000) {
        _fail('invalid_response', retryable: false);
        return;
      }
      recording.clear();
      _recording = null;
      _transcript = text;
      _insert();
    } catch (_) {
      // The standard adapter returns safe errors. An unknown adapter failure
      // cannot establish whether a request is eligible for another attempt.
      if (_current(generation)) _fail('outcome_unknown', retryable: false);
    } finally {
      bytes.fillRange(0, bytes.length, 0);
      if (!abort.isCompleted) abort.complete();
      if (identical(_abort, abort)) _abort = null;
    }
  }

  void _insert() {
    final transcript = _transcript;
    if (transcript == null || !widget.enabled) return;
    final text = [widget.controller.text.trimRight(), transcript]
        .where((part) => part.isNotEmpty)
        .join(' ');
    if (widget.maxDraftLength != null && text.length > widget.maxDraftLength!) {
      _fail('draft_limit', retryable: true);
      return;
    }
    widget.controller.value = TextEditingValue(
        text: text, selection: TextSelection.collapsed(offset: text.length));
    widget.onChanged?.call(text);
    _release();
    _phaseChanged(_Phase.idle);
  }

  void _fail(String code, {required bool retryable}) {
    _timer?.cancel();
    _error = code;
    _retryable = retryable;
    if (!retryable) {
      _recording?.clear();
      _recording = null;
      _transcript = null;
      final recorder = _recorder;
      _recorder = null;
      if (recorder != null)
        unawaited(recorder.dispose().catchError((Object _) {}));
    }
    _phaseChanged(_Phase.failed);
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(_errorText)));
  }

  String get _errorText => switch (_error) {
        'permission_denied' => 'Allow microphone access to dictate a message.',
        'draft_limit' => 'Shorten the draft, then insert the saved dictation.',
        'outcome_unknown' =>
          'The recording outcome could not be confirmed. It was not added to the draft.',
        'authentication_required' => 'Sign in again to use voice input.',
        _ =>
          'Voice input could not finish. Your typed draft is still available.',
      };

  @override
  Widget build(BuildContext context) =>
      Row(mainAxisSize: MainAxisSize.min, children: [
        if (_busy || _retryable)
          IconButton(
              tooltip: 'Discard recording',
              onPressed: _cancel,
              icon: const Icon(Icons.close_rounded, size: 18)),
        IconButton(
          tooltip: switch (_phase) {
            _Phase.starting => 'Starting microphone…',
            _Phase.recording => 'Stop recording and transcribe',
            _Phase.transcribing => 'Transcribing…',
            _Phase.failed when _retryable => _transcript != null
                ? 'Insert saved dictation'
                : 'Retry transcription',
            _ => 'Dictate a message',
          },
          onPressed: !widget.enabled
              ? null
              : _phase == _Phase.recording
                  ? () => unawaited(_stop())
                  : _busy
                      ? null
                      : _retryable
                          ? () => _transcript != null
                              ? _insert()
                              : unawaited(_transcribe(_generation))
                          : () => unawaited(_start()),
          color: _phase == _Phase.recording ? Colors.red : null,
          constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
          icon: _phase == _Phase.starting || _phase == _Phase.transcribing
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : Icon(
                  _phase == _Phase.recording
                      ? Icons.stop_circle_outlined
                      : _retryable
                          ? Icons.refresh
                          : Icons.mic_none_rounded,
                  size: 20),
        ),
      ]);
}
