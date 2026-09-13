import 'dart:async';
import 'dart:convert';
import 'package:handrail_ai_client/handrail_ai_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

final base = Uri.parse('https://erp.test/prefix/api/assistant');
final capability = HandrailTranscriptionCapability.fromJson({
  'formats': [
    {'media_type': 'audio/wav', 'container': 'wav'}
  ],
  'maximumBytes': 1024,
  'maximumDurationSeconds': 60,
});
Future<String> transcribe(HandrailAiClient client,
        {Future<void>? cancellation,
        Duration timeout = const Duration(seconds: 5)}) =>
    client.transcribeAudio(
      capability: capability,
      conversationId: 'one',
      idempotencyKey: 'capture:one',
      bytes: [82, 73, 70, 70],
      mediaType: 'audio/wav',
      duration: const Duration(seconds: 1),
      cancellation: cancellation,
      timeout: timeout,
    );
http.Response success() => http.Response(
    jsonEncode({
      'ok': true,
      'value': {'text': '  private draft  '},
    }),
    200);

void main() {
  test('negotiates formats and rejects invalid limits or foreign endpoints',
      () {
    expect(capability.resolveEndpoint(base).toString(),
        'https://erp.test/prefix/api/assistant/transcriptions');
    for (final url in [
      'https://foreign.test/transcribe',
      '/outside',
      '../outside',
      '//foreign.test/transcribe',
      'transcriptions#secret',
      '%2e%2e/outside'
    ]) {
      final value = HandrailTranscriptionCapability.fromJson({
        'formats': [
          {'media_type': 'audio/wav', 'container': 'wav'}
        ],
        'maximumBytes': 1024,
        'maximumDurationSeconds': 60,
        'url': url,
      });
      expect(() => value.resolveEndpoint(base),
          throwsA(isA<HandrailGatewayException>()));
    }
    expect(
        () => HandrailTranscriptionCapability.fromJson({
              'formats': [
                {'media_type': 'audio/wav', 'container': 'mp3'}
              ],
              'maximumBytes': 1024,
              'maximumDurationSeconds': 60,
            }),
        throwsFormatException);
  });

  test(
      'uses protected raw HTTP with stable request identity and no content diagnostics',
      () async {
    final requests = <Map<String, Object?>>[];
    final diagnostics = <Map<String, Object?>>[];
    var active = true;
    final transport = HandrailProtectedHttpClient(
      baseUri: base,
      authorize: (_) {
        if (!active) throw StateError('Account changed');
        return {'authorization': 'Bearer fixture'};
      },
      httpClient: MockClient((request) async {
        requests.add({
          'path': request.url.path,
          'headers': Map.of(request.headers),
          'bytes': List.of(request.bodyBytes),
          'redirects': request.followRedirects
        });
        return success();
      }),
    );
    final client = HandrailAiClient(
        baseUri: base, httpClient: transport, diagnostics: diagnostics.add);
    addTearDown(client.close);
    expect(await transcribe(client), 'private draft');
    expect(await transcribe(client), 'private draft');
    expect(requests[0], requests[1]);
    expect(requests[0]['bytes'], [82, 73, 70, 70]);
    expect(requests[0]['redirects'], isFalse);
    final headers = requests[0]['headers']! as Map;
    expect(headers['authorization'], 'Bearer fixture');
    expect(headers['content-type'], 'audio/wav');
    expect(headers['idempotency-key'], 'capture:one');
    expect(headers['x-handrail-conversation-id'], 'one');
    expect(headers['x-handrail-audio-duration-seconds'], '1.0');
    expect(jsonEncode(diagnostics), isNot(contains('private draft')));
    expect(jsonEncode(diagnostics), isNot(contains('Bearer fixture')));
    active = false;
    await expectLater(
        transcribe(client), throwsA(isA<HandrailGatewayException>()));
    expect(requests, hasLength(2));
  });

  test('cancellation excludes a late result without changing in-flight audio',
      () async {
    final sent = Completer<void>(), response = Completer<http.Response>();
    final cancellation = Completer<void>();
    late http.Request captured;
    final client = HandrailAiClient(
        baseUri: base,
        httpClient: MockClient((request) {
          captured = request;
          sent.complete();
          return response.future;
        }));
    addTearDown(client.close);
    final result = transcribe(client, cancellation: cancellation.future);
    await sent.future;
    final failed = expectLater(
        result,
        throwsA(isA<HandrailGatewayException>()
            .having((error) => error.code, 'code', 'cancelled')));
    cancellation.complete();
    await failed;
    expect(captured.bodyBytes, [82, 73, 70, 70]);
    response.complete(success());
    await Future<void>.delayed(Duration.zero);
  });

  test('response observation is bounded even when a transport ignores abort',
      () async {
    final sent = Completer<void>();
    var stopped = false;
    final stream = StreamController<List<int>>(onCancel: () {
      stopped = true;
    });
    final client = HandrailAiClient(
        baseUri: base,
        httpClient: _StreamClient((_) async {
          sent.complete();
          return http.StreamedResponse(stream.stream, 200);
        }));
    addTearDown(client.close);
    final result =
        transcribe(client, timeout: const Duration(milliseconds: 20));
    await sent.future;
    await expectLater(
        result,
        throwsA(isA<HandrailGatewayException>()
            .having((error) => error.code, 'code', 'deadline_exceeded')));
    await Future<void>.delayed(Duration.zero);
    expect(stopped, isTrue);
    await stream.close();
  });

  for (final code in [
    'outcome_unknown',
    'idempotency_conflict',
    'service_unavailable'
  ]) {
    test('safe $code errors preserve retry policy and hide provider details',
        () async {
      final client = HandrailAiClient(
          baseUri: base,
          httpClient: MockClient((_) async => http.Response(
              jsonEncode({
                'ok': false,
                'error': {
                  'code': code,
                  'message': 'raw provider private prompt'
                }
              }),
              503)));
      addTearDown(client.close);
      await expectLater(
          transcribe(client),
          throwsA(isA<HandrailGatewayException>()
              .having((error) => error.code, 'code', code)
              .having((error) => error.retryable, 'retryable',
                  code == 'service_unavailable')
              .having((error) => error.message, 'message',
                  isNot(contains('private prompt')))));
    });
  }

  test('oversized responses and unsupported capture never expose body text',
      () async {
    var calls = 0;
    final client = HandrailAiClient(
        baseUri: base,
        httpClient: MockClient((_) async {
          calls++;
          return http.Response('x' * (128 * 1024 + 1), 200);
        }));
    addTearDown(client.close);
    await expectLater(
        transcribe(client),
        throwsA(isA<HandrailGatewayException>()
            .having((error) => error.code, 'code', 'internal_failure')));
    await expectLater(
        client.transcribeAudio(
            capability: capability,
            conversationId: 'one',
            idempotencyKey: 'new',
            bytes: [1],
            mediaType: 'audio/webm',
            duration: const Duration(seconds: 1)),
        throwsA(isA<HandrailGatewayException>()));
    expect(calls, 1);
  });
}

class _StreamClient extends http.BaseClient {
  _StreamClient(this.handle);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handle;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      handle(request);
}
