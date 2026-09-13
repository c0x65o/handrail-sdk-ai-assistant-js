part of '../handrail_ai_client.dart';

/// Negotiated microphone limits; the server remains authoritative for intake.
class HandrailTranscriptionCapability {
  static const _formats = {
    'audio/flac': 'flac',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  };
  final Map<String, String> formats;
  final int maximumBytes;
  final double maximumDurationSeconds;
  final String? url;
  const HandrailTranscriptionCapability._(
      this.formats, this.maximumBytes, this.maximumDurationSeconds, this.url);

  factory HandrailTranscriptionCapability.fromJson(Map<String, Object?> json) {
    final formats = json['formats'];
    final bytes = json['maximumBytes'];
    final duration = json['maximumDurationSeconds'];
    final url = json['url'];
    if (formats is! List ||
        formats.isEmpty ||
        formats.length > 6 ||
        bytes is! int ||
        bytes < 1 ||
        bytes > 25 * 1024 * 1024 ||
        duration is! num ||
        !duration.isFinite ||
        duration <= 0 ||
        duration > 3600 ||
        (url != null && (url is! String || url.isEmpty || url.length > 2048))) {
      throw const FormatException('Invalid transcription capability.');
    }
    final allowed = <String, String>{};
    for (final format in formats) {
      if (format is! Map ||
          format['media_type'] is! String ||
          _formats[format['media_type']] != format['container'] ||
          allowed.containsKey(format['media_type'])) {
        throw const FormatException('Invalid transcription audio format.');
      }
      allowed[format['media_type'] as String] = format['container'] as String;
    }
    return HandrailTranscriptionCapability._(
        Map.unmodifiable(allowed), bytes, duration.toDouble(), url as String?);
  }

  Uri resolveEndpoint(Uri baseUri) {
    final root = baseUri.path.replaceFirst(RegExp(r'/+$'), '');
    final endpoint =
        baseUri.replace(path: '$root/').resolve(url ?? 'transcriptions');
    if (endpoint.scheme != baseUri.scheme ||
        endpoint.authority != baseUri.authority ||
        endpoint.userInfo.isNotEmpty ||
        endpoint.hasFragment ||
        !endpoint.path.startsWith('$root/') ||
        endpoint.pathSegments.any((part) =>
            part == '.' ||
            part == '..' ||
            part.contains('/') ||
            part.contains('\\'))) {
      throw const HandrailGatewayException('invalid_gateway_url',
          'The transcription endpoint is outside the assistant gateway.');
    }
    return endpoint;
  }
}

const _transcriptionCodes = {
  'invalid_request',
  'idempotency_conflict',
  'outcome_unknown',
  'unsupported',
  'unsupported_audio',
  'content_unavailable',
  'limit_exceeded',
  'cancelled',
  'deadline_exceeded',
  'rate_limited',
  'service_unavailable',
  'internal_failure',
};

HandrailGatewayException _transcriptionFailure(String code,
        {int? statusCode}) =>
    HandrailGatewayException(
        code,
        switch (code) {
          'cancelled' => 'Transcription stopped.',
          'outcome_unknown' => 'The recording outcome could not be confirmed.',
          'authentication_required' =>
            'Sign in again to transcribe this recording.',
          'limit_exceeded' => 'The recording exceeds the microphone limits.',
          'unsupported' ||
          'unsupported_audio' =>
            'This recording format is unavailable.',
          _ => 'The recording could not be transcribed.',
        },
        retryable: const {
          'deadline_exceeded',
          'rate_limited',
          'service_unavailable'
        }.contains(code),
        statusCode: statusCode);

extension HandrailClientTranscription on HandrailAiClient {
  /// Binds optional Flutter UI directly to this authenticated conversation.
  Future<({String? text, String? errorCode, bool retryable})> Function({
    required List<int> bytes,
    required String mediaType,
    required Duration duration,
    required String idempotencyKey,
    required Future<void> cancellation,
  }) transcriptionForConversation(String conversationId,
          {required HandrailTranscriptionCapability capability}) =>
      ({
        required bytes,
        required mediaType,
        required duration,
        required idempotencyKey,
        required cancellation,
      }) =>
          transcribeAudioResult(
              capability: capability,
              conversationId: conversationId,
              idempotencyKey: idempotencyKey,
              bytes: bytes,
              mediaType: mediaType,
              duration: duration,
              cancellation: cancellation);

  /// Structural result consumed by optional Flutter UI without a package-level
  /// client/widgets dependency. Never includes provider exception text.
  Future<({String? text, String? errorCode, bool retryable})>
      transcribeAudioResult({
    required HandrailTranscriptionCapability capability,
    required String conversationId,
    required String idempotencyKey,
    required List<int> bytes,
    required String mediaType,
    required Duration duration,
    Future<void>? cancellation,
  }) async {
    try {
      final text = await transcribeAudio(
          capability: capability,
          conversationId: conversationId,
          idempotencyKey: idempotencyKey,
          bytes: bytes,
          mediaType: mediaType,
          duration: duration,
          cancellation: cancellation);
      return (text: text, errorCode: null, retryable: false);
    } on HandrailGatewayException catch (error) {
      return (text: null, errorCode: error.code, retryable: error.retryable);
    } catch (_) {
      return (text: null, errorCode: 'internal_failure', retryable: false);
    }
  }

  /// Sends bounded raw audio through the same protected client as conversations.
  /// Retries must retain the same bytes and idempotency key. A cancellation
  /// stops observation; it does not assert that provider work never happened.
  Future<String> transcribeAudio({
    required HandrailTranscriptionCapability capability,
    required String conversationId,
    required String idempotencyKey,
    required List<int> bytes,
    required String mediaType,
    required Duration duration,
    Future<void>? cancellation,
    Duration timeout = const Duration(seconds: 90),
  }) async {
    final seconds = duration.inMicroseconds / Duration.microsecondsPerSecond;
    if (conversationId.isEmpty ||
        conversationId.length > 255 ||
        !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
            .hasMatch(idempotencyKey) ||
        bytes.isEmpty ||
        bytes.length > capability.maximumBytes ||
        bytes.any((byte) => byte < 0 || byte > 255) ||
        seconds <= 0 ||
        seconds > capability.maximumDurationSeconds ||
        !capability.formats.containsKey(mediaType) ||
        timeout <= Duration.zero) {
      throw _transcriptionFailure('invalid_request');
    }
    final endpoint = capability.resolveEndpoint(baseUri);
    final captured = Uint8List.fromList(bytes);
    final abort = Completer<void>();
    var expired = false;
    void cancel() {
      if (!abort.isCompleted) abort.complete();
    }

    unawaited(cancellation?.then((_) => cancel(), onError: (_) => cancel()));
    final deadline = Timer(timeout, () {
      expired = true;
      cancel();
    });
    Future<T> cancellable<T>(Future<T> work) => Future.any([
          work,
          abort.future.then<T>((_) => throw _transcriptionFailure(
              expired ? 'deadline_exceeded' : 'cancelled')),
        ]);
    final started = DateTime.now();
    _diagnose('/transcriptions', 'started');
    Future<String> execute() async {
      try {
        final headers = await cancellable(_headers());
        if (abort.isCompleted) throw _transcriptionFailure('cancelled');
        final request =
            http.AbortableRequest('POST', endpoint, abortTrigger: abort.future)
              ..followRedirects = false
              ..headers.addAll({
                ...headers,
                'accept': 'application/json',
                'content-type': mediaType,
                'idempotency-key': idempotencyKey,
                'x-handrail-conversation-id': conversationId,
                'x-handrail-audio-duration-seconds': '$seconds'
              })
              ..bodyBytes = captured;
        // Retain immutable request bytes until the actual transport settles,
        // even when a custom transport cannot abort an in-flight request.
        final response = await _http.send(request);
        final body = BytesBuilder(copy: false);
        final chunks = StreamIterator(response.stream);
        try {
          // Bound even a malformed/proxy response; provider text is never surfaced.
          while (await cancellable(chunks.moveNext())) {
            final chunk = chunks.current;
            if (body.length + chunk.length > 128 * 1024) {
              throw _transcriptionFailure('internal_failure');
            }
            body.add(chunk);
          }
        } finally {
          await chunks.cancel();
        }
        if (abort.isCompleted)
          throw _transcriptionFailure(
              expired ? 'deadline_exceeded' : 'cancelled');
        Map? decoded;
        try {
          final value = jsonDecode(utf8.decode(body.takeBytes()));
          if (value is Map) decoded = value;
        } catch (_) {/* Invalid response maps to a safe error. */}
        if (response.statusCode < 200 ||
            response.statusCode >= 300 ||
            decoded?['ok'] != true) {
          final error = decoded?['error'];
          final code =
              error is Map && _transcriptionCodes.contains(error['code'])
                  ? error['code'] as String
                  : switch (response.statusCode) {
                      401 || 403 => 'authentication_required',
                      408 || 504 => 'deadline_exceeded',
                      429 => 'rate_limited',
                      409 => 'idempotency_conflict',
                      413 => 'limit_exceeded',
                      415 => 'unsupported_audio',
                      >= 500 => 'service_unavailable',
                      _ => 'internal_failure',
                    };
          throw _transcriptionFailure(code, statusCode: response.statusCode);
        }
        final value = decoded?['value'];
        final text = value is Map ? value['text'] : null;
        if (text is! String || text.trim().isEmpty || text.length > 20000) {
          throw _transcriptionFailure('internal_failure');
        }
        _diagnose('/transcriptions', 'succeeded',
            started: started, statusCode: response.statusCode);
        return text.trim();
      } finally {
        captured.fillRange(0, captured.length, 0);
      }
    }

    try {
      return await cancellable(execute());
    } catch (error) {
      final safe = abort.isCompleted
          ? _transcriptionFailure(expired ? 'deadline_exceeded' : 'cancelled')
          : error is HandrailGatewayException
              ? error
              : _transcriptionFailure('service_unavailable');
      _diagnoseFailure('/transcriptions', started, safe);
      throw safe;
    } finally {
      deadline.cancel();
    }
  }
}
