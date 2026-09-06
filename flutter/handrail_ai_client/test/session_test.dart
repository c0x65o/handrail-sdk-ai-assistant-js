import 'dart:async';
import 'dart:convert';
import 'package:handrail_ai_client/handrail_ai_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

Map<String, Object?> snapshot(
        {String conversationId = 'c1',
        int revision = 1,
        bool running = true,
        Object? replayError}) =>
    {
      'conversationId': conversationId,
      'revision': revision,
      'state': {
        'conversation_id': conversationId,
        'revision': revision,
        'active_turn_id': running ? 't1' : null,
        'messages': [
          {
            'message_id': 'answer',
            'turn_id': 't1',
            'role': 'assistant',
            'content': [
              {'type': 'text', 'text': running ? 'Working' : 'Finished'}
            ],
            'attachments': []
          }
        ],
        'turns': [
          {
            'turn_id': 't1',
            'status': running ? 'running' : 'completed',
            'remote_may_still_be_running': running,
            'output_message_ids': ['answer']
          }
        ],
        'tool_calls': [],
        'approval_proposals': [],
        'citations': [],
        'attachments': [],
        'replay_error': replayError,
      },
    };
http.Response ok(Object? value) =>
    http.Response(jsonEncode({'ok': true, 'value': value}), 200);

class PendingHeadersClient extends http.BaseClient {
  final started = Completer<void>();
  final aborted = Completer<void>();
  bool closed = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    expect(request, isA<http.AbortableRequest>());
    expect(request.followRedirects, isFalse);
    (request as http.AbortableRequest)
        .abortTrigger!
        .then((_) => aborted.complete());
    started.complete();
    return Completer<http.StreamedResponse>().future;
  }

  @override
  void close() {
    closed = true;
  }
}

void main() {
  test(
      'disconnect aborts pending response headers without closing the shared HTTP client',
      () async {
    final transport = PendingHeadersClient();
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: transport);
    final subscription =
        client.startTurn({'conversationId': 'c1'}).listen((_) {});
    await transport.started.future;
    await subscription.cancel().timeout(const Duration(seconds: 2));
    await transport.aborted.future;
    expect(transport.closed, isFalse);
    client.close();
  });

  test(
      'reload resumes an existing turn, then canonical completion and read acknowledgement win',
      () async {
    var running = true, unread = false;
    final requests = <http.Request>[];
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: MockClient((request) async {
          requests.add(request);
          if (request.url.path.endsWith('/capabilities'))
            return ok({
              'protocolVersion': applicationGatewayProtocolVersion,
              'synchronization': true,
              'activity': true
            });
          final body = jsonDecode(request.body) as Map;
          if (request.url.path.endsWith('/synchronization')) {
            if (body['operation'] == 'read_since')
              return ok({
                'status': 'events',
                'events': running ? [] : [{}],
                'hasMore': false
              });
            return ok({
              'status': 'snapshot',
              'snapshot': snapshot(running: running, revision: running ? 1 : 2)
            });
          }
          if (request.url.path.endsWith('/activity')) {
            if (body['operation'] == 'mark_read') unread = false;
            final record = {
              'conversationId': 'c1',
              'turnId': 't1',
              'turnRevision': 1,
              'turnStatus': running ? 'running' : 'completed',
              'unread': unread,
              'updatedAt': '2026-09-04T00:00:00Z'
            };
            return ok(body['operation'] == 'mark_read' ? record : [record]);
          }
          expect(request.url.path, endsWith('/turns/resume'));
          expect(body['turnId'], 't1');
          return http.Response(
              'event: terminal\ndata: {"result":{"status":"disconnected","checkpoint":{"lastAppliedCursor":"t1:4"}}}\n\n',
              200);
        }));
    final session = HandrailConversationSession(
        client: client, conversationId: 'c1', pollingInterval: null);
    await session.initialize();
    await Future<void>.delayed(Duration.zero);
    expect(session.document!.runtimeState.text, 'Working');
    expect(session.workspace.snapshot.runningCount, 1);
    expect(session.observationConnected, isFalse);
    await session.refresh();
    await Future<void>.delayed(Duration.zero);
    final resumes = requests
        .where((request) => request.url.path.endsWith('/turns/resume'))
        .toList();
    expect(resumes, hasLength(2));
    expect((jsonDecode(resumes.last.body) as Map)['resumeFrom'],
        {'lastAppliedCursor': 't1:4'});
    running = false;
    unread = true;
    await session.refresh();
    expect(session.document!.runtimeState.text, 'Finished');
    expect(session.workspace.snapshot.runningCount, 0);
    expect(session.workspace.snapshot.unreadCount, 1);
    await session.markRead();
    expect(session.workspace.snapshot.unreadCount, 0);
    expect(requests.any((request) => request.url.path.endsWith('/turns/start')),
        isFalse);
    expect(requests.any((request) => request.body.contains('append_mutations')),
        isFalse);
    await session.dispose();
    client.close();
  });

  test(
      'overlapping refreshes share a request and disposal rejects late results',
      () async {
    final response = Completer<http.Response>();
    final requested = Completer<void>();
    var snapshots = 0;
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/capabilities'))
            return ok({
              'protocolVersion': applicationGatewayProtocolVersion,
              'synchronization': true
            });
          snapshots++;
          requested.complete();
          return response.future;
        }));
    final session = HandrailConversationSession(
        client: client, conversationId: 'c1', pollingInterval: null);
    final first = session.refresh();
    final second = session.refresh();
    expect(identical(first, second), isTrue);
    await requested.future;
    await session.dispose();
    response.complete(ok({'status': 'snapshot', 'snapshot': snapshot()}));
    await Future.wait([first, second]);
    expect(snapshots, 1);
    expect(session.document, isNull);
    client.close();
  });

  test('a delayed read response keeps a newer failed result unread', () async {
    final old = HandrailConversationActivityRecord(
        conversationId: 'c1',
        turnId: 't1',
        turnRevision: 1,
        status: HandrailTurnStatus.completed,
        unread: true,
        updatedAt: DateTime.utc(2026, 9, 6));
    final workspace = HandrailConversationWorkspace();
    workspace.replaceRemoteActivity([old]);
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: MockClient((request) async {
          final body = jsonDecode(request.body) as Map;
          expect(body['operation'], 'mark_read');
          expect(body['observed'], old.toJson());
          return ok({
            ...old.toJson(),
            'turnId': 't2',
            'turnRevision': 2,
            'turnStatus': 'error',
            'unread': true,
          });
        }));
    final session = HandrailConversationSession(
        client: client,
        conversationId: 'c1',
        workspace: workspace,
        pollingInterval: null);
    await session.markRead();
    expect(workspace.snapshot.unreadCount, 1);
    expect(workspace.remoteActivityFor('c1')!.turnId, 't2');
    expect(
        workspace.remoteActivityFor('c1')!.status, HandrailTurnStatus.failed);
    await session.dispose();
    await workspace.dispose();
    client.close();
  });

  test('a failed synchronization keeps the last known server run', () async {
    var fail = false;
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/capabilities'))
            return ok({
              'protocolVersion': applicationGatewayProtocolVersion,
              'synchronization': true
            });
          if (request.url.path.endsWith('/turns/resume'))
            return http.Response('', 200);
          if (fail) return ok({'status': 'temporarily_unavailable'});
          return ok({'status': 'snapshot', 'snapshot': snapshot()});
        }));
    final session = HandrailConversationSession(
        client: client, conversationId: 'c1', pollingInterval: null);
    await session.initialize();
    fail = true;
    await expectLater(
        session.refresh(), throwsA(isA<HandrailGatewayException>()));
    expect(session.workspace.snapshot.runningCount, 1);
    expect(session.error?.retryable, isTrue);
    await session.dispose();
    client.close();
  });

  test('cancellation requests do not report idle before server confirmation',
      () async {
    var requested = false;
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/capabilities'))
            return ok({
              'protocolVersion': applicationGatewayProtocolVersion,
              'synchronization': true,
              'authoritativeCancellation': true
            });
          if (request.url.path.endsWith('/turns/resume'))
            return http.Response('', 200);
          if (request.url.path.endsWith('/turns/cancel')) {
            requested = true;
            expect(jsonDecode(request.body), containsPair('turnId', 't1'));
            return ok({'status': 'cancellation_requested'});
          }
          final body = jsonDecode(request.body) as Map;
          return ok(body['operation'] == 'pull_snapshot'
              ? {'status': 'snapshot', 'snapshot': snapshot()}
              : {'status': 'events', 'events': [], 'hasMore': false});
        }));
    final session = HandrailConversationSession(
        client: client, conversationId: 'c1', pollingInterval: null);
    await session.initialize();
    await session.requestCancellation(
        mutationId: 'stop', idempotencyKey: 'stop');
    expect(requested, isTrue);
    expect(session.workspace.snapshot.runningCount, 1);
    await session.dispose();
    client.close();
  });

  test('initial transient failure keeps polling until recovery', () async {
    var attempts = 0;
    final recovered = Completer<void>();
    final client = HandrailAiClient(
        baseUri: Uri.parse('https://app.example/api/ai'),
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/capabilities'))
            return ok({
              'protocolVersion': applicationGatewayProtocolVersion,
              'synchronization': true
            });
          attempts++;
          return attempts == 1
              ? ok({'status': 'temporarily_unavailable'})
              : ok(
                  {'status': 'snapshot', 'snapshot': snapshot(running: false)});
        }));
    final session = HandrailConversationSession(
        client: client,
        conversationId: 'c1',
        pollingInterval: const Duration(milliseconds: 100));
    final subscription = session.changes.listen((value) {
      if (value.document != null && !recovered.isCompleted)
        recovered.complete();
    });
    await expectLater(
        session.initialize(), throwsA(isA<HandrailGatewayException>()));
    await recovered.future.timeout(const Duration(seconds: 3));
    expect(session.document!.runtimeState.status, HandrailTurnStatus.completed);
    await session.dispose();
    await subscription.cancel();
    client.close();
  });

  test(
      'canonical snapshots reject cross-conversation or replay-error evidence and retain immutable data',
      () {
    expect(() => HandrailConversationDocument.fromSnapshot('other', snapshot()),
        throwsA(isA<HandrailGatewayException>()));
    expect(
        () => HandrailConversationDocument.fromSnapshot(
            'c1', snapshot(replayError: {'code': 'invalid'})),
        throwsA(isA<HandrailGatewayException>()));
    final source = snapshot();
    final document = HandrailConversationDocument.fromSnapshot('c1', source);
    ((source['state'] as Map)['messages'] as List).clear();
    expect(document.messages, hasLength(1));
    expect(() => (document.state['turns'] as List).clear(),
        throwsUnsupportedError);
  });
}
