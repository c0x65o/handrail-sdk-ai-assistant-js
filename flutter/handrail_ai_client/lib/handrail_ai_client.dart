library handrail_ai_client;

import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'src/platform_http_client.dart' as platform_http;

part 'src/session.dart';
part 'src/submission.dart';
part 'src/protected_http.dart';
part 'src/pending_turn_store.dart';
part 'src/realtime_calls.dart';
part 'src/realtime_activity.dart';
part 'src/realtime_workspace.dart';

const applicationGatewayProtocolVersion = 'handrail.application-gateway.v1';

typedef ProtectedHeaders = FutureOr<Map<String, String>> Function();
typedef HandrailDiagnosticSink = void Function(Map<String, Object?> event);

class HandrailGatewayCapabilities {
  final bool authoritativeCancellation;
  final Map<String, Object?>? attachments;
  final Map<String, Object?>? documentInput;
  final bool presence;
  final bool activity;
  final bool synchronization;
  final Map<String, Object?> resources;
  const HandrailGatewayCapabilities({
    required this.authoritativeCancellation,
    this.attachments,
    this.documentInput,
    required this.presence,
    this.activity = false,
    required this.synchronization,
    this.resources = const {},
  });
  factory HandrailGatewayCapabilities.fromJson(Map<String, Object?> json) =>
      HandrailGatewayCapabilities(
        authoritativeCancellation: json['authoritativeCancellation'] == true,
        attachments: json['attachments'] is Map
            ? Map<String, Object?>.from(json['attachments'] as Map)
            : null,
        documentInput: json['documentInput'] is Map
            ? Map<String, Object?>.unmodifiable(json['documentInput'] as Map)
            : null,
        presence: json['presence'] == true,
        activity: json['activity'] == true,
        synchronization: json['synchronization'] == true,
        resources: json['resources'] is Map
            ? Map<String, Object?>.unmodifiable(json['resources'] as Map)
            : const {},
      );
}

enum HandrailTurnStatus {
  idle,
  running,
  waitingForTool,
  completed,
  cancelled,
  failed,
}

class HandrailConversationState {
  final String conversationId;
  final String text;
  final HandrailTurnStatus status;

  /// Observation connectivity is independent of the server-owned run status.
  final bool observationConnected;
  final String? turnId;
  final int? turnRevision;
  final int? lastSequence;
  final Set<String> appliedFrameIds;
  final Set<String> supersededTurnIds;
  final List<Map<String, Object?>> toolCalls;
  final List<Map<String, Object?>> approvals;
  final List<Map<String, Object?>> citations;
  final List<Map<String, Object?>> attachments;
  const HandrailConversationState({
    required this.conversationId,
    this.text = '',
    this.status = HandrailTurnStatus.idle,
    this.observationConnected = false,
    this.turnId,
    this.turnRevision,
    this.lastSequence,
    this.appliedFrameIds = const {},
    this.supersededTurnIds = const {},
    this.toolCalls = const [],
    this.approvals = const [],
    this.citations = const [],
    this.attachments = const [],
  });

  HandrailConversationState apply(HandrailStreamFrame frame) {
    final payload = frame.data['event'] is Map
        ? Map<String, Object?>.from(frame.data['event'] as Map)
        : frame.data;
    final type = payload['type'];
    final incomingTurn =
        frame.data['turnId'] as String? ?? payload['request_id'] as String?;
    if (incomingTurn != null && supersededTurnIds.contains(incomingTurn))
      return this;
    final differentTurn =
        incomingTurn != null && turnId != null && incomingTurn != turnId;
    if (differentTurn && type != 'response.started' && frame.type != 'started')
      return this;
    final sequence = payload['sequence'] as int?;
    if (!differentTurn &&
        (frame.id != null && appliedFrameIds.contains(frame.id) ||
            sequence != null &&
                lastSequence != null &&
                sequence <= lastSequence!)) return this;
    if (!differentTurn &&
        turnId != null &&
        _terminalStatus(status) &&
        (frame.type == 'started' ||
            type == 'response.started' ||
            type == 'response.text.delta' ||
            type == 'response.tool_call')) return this;
    var nextStatus = differentTurn ? HandrailTurnStatus.idle : status;
    var nextText = differentTurn ? '' : text;
    var connected = frame.type == 'event' || frame.type == 'started'
        ? true
        : observationConnected;
    final nextTools = differentTurn ? <Map<String, Object?>>[] : [...toolCalls],
        nextApprovals =
            differentTurn ? <Map<String, Object?>>[] : [...approvals],
        nextCitations =
            differentTurn ? <Map<String, Object?>>[] : [...citations],
        nextAttachments =
            differentTurn ? <Map<String, Object?>>[] : [...attachments];
    if (frame.type == 'started' || type == 'response.started') {
      nextStatus = HandrailTurnStatus.running;
      connected = true;
    }
    if (type == 'response.text.delta')
      nextText += payload['delta'] as String? ?? '';
    if (type == 'response.tool_call') {
      nextStatus = HandrailTurnStatus.waitingForTool;
      nextTools.add(Map.unmodifiable(payload));
    }
    if (type == 'response.citation_batch')
      nextCitations.add(Map.unmodifiable(payload));
    if (type == 'approval.proposal_created' ||
        type == 'approval.proposal_status_changed')
      nextApprovals.add(Map.unmodifiable(payload));
    if (type == 'message.attachment_referenced')
      nextAttachments.add(Map.unmodifiable(payload));
    if (type == 'response.cancelled') nextStatus = HandrailTurnStatus.cancelled;
    if (type == 'response.error') nextStatus = HandrailTurnStatus.failed;
    if (type == 'response.completed') nextStatus = HandrailTurnStatus.completed;
    if (frame.type == 'terminal') {
      final terminal = frame.data['result'] is Map
          ? Map<String, Object?>.from(frame.data['result'] as Map)
          : frame.data;
      final terminalStatus = terminal['status'];
      if (terminalStatus == 'completed')
        nextStatus = HandrailTurnStatus.completed;
      if (terminalStatus == 'cancelled')
        nextStatus = HandrailTurnStatus.cancelled;
      if (terminalStatus == 'failed') nextStatus = HandrailTurnStatus.failed;
      connected = false;
    }
    return HandrailConversationState(
      conversationId: conversationId,
      text: nextText,
      status: nextStatus,
      observationConnected: _terminalStatus(nextStatus) ? false : connected,
      turnId: incomingTurn ?? turnId,
      turnRevision: differentTurn ? null : turnRevision,
      lastSequence: sequence ?? (differentTurn ? null : lastSequence),
      appliedFrameIds: Set.unmodifiable({
        if (!differentTurn) ...appliedFrameIds,
        if (frame.id != null && sequence == null) frame.id!
      }),
      supersededTurnIds:
          Set.unmodifiable({...supersededTurnIds, if (differentTurn) turnId!}),
      toolCalls: List.unmodifiable(nextTools),
      approvals: List.unmodifiable(nextApprovals),
      citations: List.unmodifiable(nextCitations),
      attachments: List.unmodifiable(nextAttachments),
    );
  }
}

bool _terminalStatus(HandrailTurnStatus status) =>
    status == HandrailTurnStatus.completed ||
    status == HandrailTurnStatus.cancelled ||
    status == HandrailTurnStatus.failed;

class HandrailConversationWorkspaceEntry {
  final HandrailConversationState state;
  final bool unread;
  final String? summary;
  final HandrailConversationActivityProgress? progress;
  const HandrailConversationWorkspaceEntry(this.state,
      {this.unread = false, this.summary, this.progress});
}

class HandrailConversationActivityProgress {
  final int completed;
  final int total;
  final String? unit;
  const HandrailConversationActivityProgress({
    required this.completed,
    required this.total,
    this.unit,
  });
  factory HandrailConversationActivityProgress.fromJson(
    Map<String, Object?> json,
  ) =>
      HandrailConversationActivityProgress(
        completed: json['completed'] as int,
        total: json['total'] as int,
        unit: json['unit'] as String?,
      );
}

class HandrailConversationActivityRecord {
  final String conversationId;
  final String? turnId;
  final int? turnRevision;
  final HandrailTurnStatus status;
  final bool unread;
  final DateTime? updatedAt;
  final String? summary;
  final HandrailConversationActivityProgress? progress;
  const HandrailConversationActivityRecord({
    required this.conversationId,
    this.turnId,
    this.turnRevision,
    required this.status,
    required this.unread,
    this.updatedAt,
    this.summary,
    this.progress,
  });
  Map<String, Object?> toJson() => {
        'conversationId': conversationId,
        if (turnId != null) 'turnId': turnId,
        if (turnRevision != null) 'turnRevision': turnRevision,
        'turnStatus': switch (status) {
          HandrailTurnStatus.running ||
          HandrailTurnStatus.waitingForTool =>
            'running',
          HandrailTurnStatus.failed => 'error',
          HandrailTurnStatus.completed ||
          HandrailTurnStatus.cancelled =>
            'completed',
          _ => 'idle',
        },
        'unread': unread,
        if (updatedAt != null)
          'updatedAt': updatedAt!.toUtc().toIso8601String(),
      };
  factory HandrailConversationActivityRecord.fromJson(
    Map<String, Object?> json,
  ) {
    final status = switch (json['turnStatus']) {
      'running' => HandrailTurnStatus.running,
      'completed' => HandrailTurnStatus.completed,
      'error' => HandrailTurnStatus.failed,
      _ => HandrailTurnStatus.idle,
    };
    return HandrailConversationActivityRecord(
      conversationId: json['conversationId'] as String,
      turnId: json['turnId'] as String?,
      turnRevision: json['turnRevision'] as int?,
      status: status,
      unread: json['unread'] == true,
      updatedAt: json['updatedAt'] is String
          ? DateTime.parse(json['updatedAt'] as String).toUtc()
          : null,
      summary: json['summary'] as String?,
      progress: json['progress'] is Map
          ? HandrailConversationActivityProgress.fromJson(
              Map<String, Object?>.from(json['progress'] as Map),
            )
          : null,
    );
  }
}

class HandrailConversationWorkspaceSnapshot {
  final String? selectedConversationId;
  final List<HandrailConversationWorkspaceEntry> conversations;
  final int runningCount;
  final int errorCount;
  final int unreadCount;
  const HandrailConversationWorkspaceSnapshot({
    required this.selectedConversationId,
    required this.conversations,
    required this.runningCount,
    required this.errorCount,
    required this.unreadCount,
  });
}

/// Tracks independent background turns so changing chats never stops a stream.
class HandrailConversationWorkspace {
  final Map<String, HandrailConversationWorkspaceEntry> _entries = {};
  final Map<String, HandrailConversationActivityRecord> _remoteActivity = {};
  final StreamController<HandrailConversationWorkspaceSnapshot> _changes =
      StreamController<HandrailConversationWorkspaceSnapshot>.broadcast(
    sync: true,
  );
  String? _selectedConversationId;

  Stream<HandrailConversationWorkspaceSnapshot> get changes => _changes.stream;
  HandrailConversationWorkspaceSnapshot get snapshot => _snapshot();

  void open(HandrailConversationState state, {bool select = true}) {
    final current = _entries[state.conversationId];
    _entries[state.conversationId] = HandrailConversationWorkspaceEntry(
      state,
      unread: current?.unread ?? false,
    );
    if (select) _selectedConversationId = state.conversationId;
    _publish();
  }

  HandrailConversationState apply(
    String conversationId,
    HandrailStreamFrame frame,
  ) {
    final current = _entries[conversationId] ??
        HandrailConversationWorkspaceEntry(
          HandrailConversationState(conversationId: conversationId),
        );
    final wasRunning = current.state.status == HandrailTurnStatus.running ||
        current.state.status == HandrailTurnStatus.waitingForTool;
    final next = current.state.apply(frame);
    final terminal = next.status == HandrailTurnStatus.completed ||
        next.status == HandrailTurnStatus.cancelled ||
        next.status == HandrailTurnStatus.failed;
    _entries[conversationId] = HandrailConversationWorkspaceEntry(
      next,
      unread: current.unread ||
          (_selectedConversationId != conversationId && wasRunning && terminal),
    );
    _publish();
    return next;
  }

  void select(String? conversationId) {
    _selectedConversationId = conversationId;
    final selected = conversationId == null ? null : _entries[conversationId];
    if (conversationId != null && selected != null && selected.unread) {
      _entries[conversationId] = HandrailConversationWorkspaceEntry(
        selected.state,
      );
    }
    _publish();
  }

  void close(String conversationId) {
    _entries.remove(conversationId);
    if (_selectedConversationId == conversationId)
      _selectedConversationId = null;
    _publish();
  }

  /// Replaces the server-backed index used for unopened or remotely running chats.
  void replaceRemoteActivity(
    Iterable<HandrailConversationActivityRecord> records,
  ) {
    final next = <String, HandrailConversationActivityRecord>{};
    for (final record in records) {
      if (record.conversationId.isEmpty || record.conversationId.length > 256)
        throw ArgumentError.value(record.conversationId, 'conversationId');
      if (next.containsKey(record.conversationId))
        throw ArgumentError('Duplicate remote conversation activity');
      final previous = _remoteActivity[record.conversationId];
      final olderRevision = previous?.turnRevision != null &&
          record.turnRevision != null &&
          record.turnRevision! < previous!.turnRevision!;
      final olderTime = previous?.updatedAt != null &&
          record.updatedAt != null &&
          record.updatedAt!.isBefore(previous!.updatedAt!);
      final staleUnread = previous != null &&
          !previous.unread &&
          record.unread &&
          previous.turnId == record.turnId &&
          previous.turnRevision == record.turnRevision &&
          previous.updatedAt != null &&
          previous.updatedAt == record.updatedAt &&
          previous.status == record.status &&
          _terminalStatus(record.status);
      next[record.conversationId] = staleUnread ||
              olderRevision ||
              (!((record.turnRevision ?? 0) > (previous?.turnRevision ?? 0)) &&
                  olderTime)
          ? previous
          : record;
    }
    _remoteActivity
      ..clear()
      ..addAll(next);
    _publish();
  }

  HandrailConversationActivityRecord? remoteActivityFor(
          String conversationId) =>
      _remoteActivity[conversationId];

  /// Merge an authoritative read response, including any newer unread result.
  void acceptRemoteActivity(HandrailConversationActivityRecord record) {
    replaceRemoteActivity([
      ..._remoteActivity.values
          .where((item) => item.conversationId != record.conversationId),
      record,
    ]);
  }

  void markRemoteRead(String conversationId) {
    final current = _remoteActivity[conversationId];
    if (current == null || !current.unread) return;
    _remoteActivity[conversationId] = HandrailConversationActivityRecord(
      conversationId: current.conversationId,
      turnId: current.turnId,
      turnRevision: current.turnRevision,
      status: current.status,
      unread: false,
      updatedAt: current.updatedAt,
      summary: current.summary,
      progress: current.progress,
    );
    _publish();
  }

  HandrailConversationWorkspaceEntry _projectEntry(
      HandrailConversationWorkspaceEntry entry) {
    final state = entry.state;
    final remote = _remoteActivity[state.conversationId];
    if (remote == null) return entry;
    final olderTurn = remote.turnId != null &&
        state.supersededTurnIds.contains(remote.turnId);
    final olderRevision = remote.turnRevision != null &&
        state.turnRevision != null &&
        remote.turnRevision! < state.turnRevision!;
    final terminalAlreadyKnown = remote.turnId != null &&
        remote.turnId == state.turnId &&
        _terminalStatus(state.status) &&
        (remote.status == HandrailTurnStatus.running ||
            remote.status == HandrailTurnStatus.waitingForTool);
    final unversionedWhileConnected = remote.turnId == null &&
        state.observationConnected &&
        (state.status == HandrailTurnStatus.running ||
            state.status == HandrailTurnStatus.waitingForTool);
    final localWins = olderTurn ||
        olderRevision ||
        terminalAlreadyKnown ||
        unversionedWhileConnected;
    return HandrailConversationWorkspaceEntry(
      HandrailConversationState(
        conversationId: state.conversationId,
        text: state.text,
        status: localWins ? state.status : remote.status,
        observationConnected: state.observationConnected,
        turnId: localWins ? state.turnId : remote.turnId ?? state.turnId,
        turnRevision: localWins
            ? state.turnRevision
            : remote.turnRevision ?? state.turnRevision,
        lastSequence: state.lastSequence,
        appliedFrameIds: state.appliedFrameIds,
        supersededTurnIds: state.supersededTurnIds,
        toolCalls: state.toolCalls,
        approvals: state.approvals,
        citations: state.citations,
        attachments: state.attachments,
      ),
      unread: olderTurn || olderRevision ? entry.unread : remote.unread,
      summary: localWins ? entry.summary : remote.summary,
      progress: localWins ? entry.progress : remote.progress,
    );
  }

  HandrailConversationWorkspaceSnapshot _snapshot() {
    final values = List<HandrailConversationWorkspaceEntry>.unmodifiable(
      _entries.values.map(_projectEntry),
    );
    final unopened = _remoteActivity.values.where(
      (record) => !_entries.containsKey(record.conversationId),
    );
    return HandrailConversationWorkspaceSnapshot(
      selectedConversationId: _selectedConversationId,
      conversations: values,
      runningCount: values
              .where(
                (entry) =>
                    entry.state.status == HandrailTurnStatus.running ||
                    entry.state.status == HandrailTurnStatus.waitingForTool,
              )
              .length +
          unopened
              .where(
                (record) =>
                    record.status == HandrailTurnStatus.running ||
                    record.status == HandrailTurnStatus.waitingForTool,
              )
              .length,
      errorCount: values
              .where((entry) => entry.state.status == HandrailTurnStatus.failed)
              .length +
          unopened
              .where((record) => record.status == HandrailTurnStatus.failed)
              .length,
      unreadCount: values.where((entry) => entry.unread).length +
          unopened.where((record) => record.unread).length,
    );
  }

  void _publish() {
    if (!_changes.isClosed) _changes.add(_snapshot());
  }

  Future<void> dispose() => _changes.close();
}

class HandrailGatewayException implements Exception {
  final String code;
  final String message;
  final bool retryable;
  final int? statusCode;
  const HandrailGatewayException(
    this.code,
    this.message, {
    this.retryable = false,
    this.statusCode,
  });
  @override
  String toString() => 'HandrailGatewayException($code): $message';
}

class HandrailStreamFrame {
  final String type;
  final String? id;
  final Map<String, Object?> data;
  const HandrailStreamFrame(this.type, this.id, this.data);
}

class HandrailAiClient {
  final Uri baseUri;
  final http.Client _http;
  final ProtectedHeaders? protectedHeaders;
  final HandrailDiagnosticSink? diagnostics;
  HandrailAiClient({
    required this.baseUri,
    http.Client? httpClient,
    this.protectedHeaders,
    this.diagnostics,
  }) : _http = httpClient ?? http.Client();

  Future<Map<String, String>> _headers() async => {
        'content-type': 'application/json',
        ...?await protectedHeaders?.call(),
      };
  Uri _uri(String path) => baseUri.replace(
        path: '${baseUri.path.replaceFirst(RegExp(r'/$'), '')}$path',
      );

  Future<HandrailGatewayCapabilities> capabilities() async {
    final started = DateTime.now();
    _diagnose('/capabilities', 'started');
    try {
      final response = await _http.get(
        _uri('/capabilities'),
        headers: await _headers(),
      );
      final body = _success(response);
      final value = Map<String, Object?>.from(body['value'] as Map);
      if (value['protocolVersion'] != applicationGatewayProtocolVersion)
        throw StateError('Incompatible Handrail gateway protocol');
      _diagnose(
        '/capabilities',
        'succeeded',
        started: started,
        statusCode: response.statusCode,
      );
      return HandrailGatewayCapabilities.fromJson(value);
    } catch (error) {
      _diagnoseFailure('/capabilities', started, error);
      rethrow;
    }
  }

  Stream<HandrailStreamFrame> startTurn(Map<String, Object?> request) =>
      _stream('/turns/start', request);
  Stream<HandrailStreamFrame> resumeTurn({
    required String conversationId,
    required String turnId,
    required Map<String, Object?> resumeFrom,
  }) =>
      _stream('/turns/resume', {
        'conversationId': conversationId,
        'turnId': turnId,
        'resumeFrom': resumeFrom,
      });

  Future<Map<String, Object?>> cancelTurn(Map<String, Object?> request) async {
    return _post('/turns/cancel', request);
  }

  Future<Map<String, Object?>> listConversations(Map<String, Object?> input) =>
      _post('/conversations/list', input);
  Future<Map<String, Object?>> createConversation(Map<String, Object?> input) =>
      _post('/conversations/create', input);
  Future<Map<String, Object?>> getConversation(String conversationId) =>
      _post('/conversations/get', {'conversationId': conversationId});
  Future<Map<String, Object?>> renameConversation(Map<String, Object?> input) =>
      _post('/conversations/rename', input);
  Future<Map<String, Object?>> archiveConversation(
    Map<String, Object?> input,
  ) =>
      _post('/conversations/archive', input);
  Future<Map<String, Object?>> restoreConversation(
    Map<String, Object?> input,
  ) =>
      _post('/conversations/restore', input);
  Future<Map<String, Object?>> clearConversation(Map<String, Object?> input) =>
      _post('/conversations/clear', input);
  Future<Map<String, Object?>> permanentlyDeleteConversation(
    Map<String, Object?> input,
  ) =>
      _post('/conversations/permanent-delete', input);
  Future<Map<String, Object?>> createApproval(Map<String, Object?> input) =>
      _post('/approvals/create', input);
  Future<Map<String, Object?>> getApproval(String proposalId) =>
      _post('/approvals/get', {'proposalId': proposalId});
  Future<Map<String, Object?>> listApprovalGroup(String groupId) =>
      _post('/approvals/list-group', {'groupId': groupId});
  Future<Map<String, Object?>> transitionApproval(Map<String, Object?> input) =>
      _post('/approvals/transition', input);
  Future<String> generateTitle({
    required String conversationId,
    required String idempotencyKey,
  }) async {
    final result = await _post('/titles/generate', {
      'conversationId': conversationId,
      'idempotencyKey': idempotencyKey,
    });
    return result['value'] as String;
  }

  Future<Map<String, Object?>> synchronize(Map<String, Object?> input) =>
      _post('/synchronization', input);

  Future<List<HandrailConversationActivityRecord>> listActivity() async {
    final result = await _post('/activity', {'operation': 'list'});
    final values = result['value'] as List? ?? const [];
    return List.unmodifiable(
      values.map(
        (value) => HandrailConversationActivityRecord.fromJson(
          Map<String, Object?>.from(value as Map),
        ),
      ),
    );
  }

  Future<HandrailConversationActivityRecord?> markActivityRead(
    String conversationId, {
    HandrailConversationActivityRecord? observed,
  }) async {
    final result = await _post('/activity', {
      'operation': 'mark_read',
      'conversationId': conversationId,
      if (observed != null) 'observed': observed.toJson(),
    });
    return result['value'] is Map
        ? HandrailConversationActivityRecord.fromJson(
            Map<String, Object?>.from(result['value'] as Map),
          )
        : null;
  }

  /// Protected live launcher activity. Keep [listActivity] polling as the
  /// convergence fallback after a disconnect or missed publication.
  Stream<HandrailConversationActivityRecord> activity() async* {
    await for (final frame
        in _streamRequest(http.Request('GET', _uri('/activity')))) {
      final value = frame.data['record'];
      if (value is Map) {
        yield HandrailConversationActivityRecord.fromJson(
          Map<String, Object?>.from(value),
        );
      }
    }
  }

  Stream<HandrailStreamFrame> presence(String conversationId) => _streamRequest(
        http.Request(
          'GET',
          _uri(
            '/presence',
          ).replace(queryParameters: {'conversationId': conversationId}),
        ),
      );

  Future<void> publishPresence(
    String conversationId,
    String kind,
    Map<String, Object?> record,
  ) async {
    final uri = _uri(
      '/presence',
    ).replace(queryParameters: {'conversationId': conversationId});
    final response = await _http.post(
      uri,
      headers: await _headers(),
      body: jsonEncode({'kind': kind, 'record': record}),
    );
    _success(response);
  }

  Future<Map<String, Object?>> uploadAttachment({
    required List<int> bytes,
    required String filename,
    required String mediaType,
    required String kind,
    required String idempotencyKey,
  }) async {
    final request = http.MultipartRequest('POST', _uri('/attachments'))
      ..headers.addAll(await _headers())
      ..fields['kind'] = kind
      ..fields['mediaType'] = mediaType
      ..fields['idempotencyKey'] = idempotencyKey
      ..files.add(
        http.MultipartFile.fromBytes('file', bytes,
            filename: filename, contentType: http.MediaType.parse(mediaType)),
      );
    final response = await http.Response.fromStream(await _http.send(request));
    return _success(response);
  }

  Future<Map<String, Object?>> _post(
    String path,
    Map<String, Object?> input,
  ) async {
    final started = DateTime.now();
    _diagnose(path, 'started');
    try {
      final response = await _http.post(
        _uri(path),
        headers: await _headers(),
        body: jsonEncode(input),
      );
      final value = _success(response);
      _diagnose(
        path,
        'succeeded',
        started: started,
        statusCode: response.statusCode,
      );
      return value;
    } catch (error) {
      _diagnose(
        path,
        'failed',
        started: started,
        code: error is HandrailGatewayException
            ? error.code
            : error.runtimeType.toString(),
        retryable: error is HandrailGatewayException && error.retryable,
        statusCode: error is HandrailGatewayException ? error.statusCode : null,
      );
      rethrow;
    }
  }

  Stream<HandrailStreamFrame> _stream(
    String path,
    Map<String, Object?> payload,
  ) =>
      _streamRequest(
        http.Request('POST', _uri(path))..body = jsonEncode(payload),
      );

  Stream<HandrailStreamFrame> _streamRequest(http.Request source) {
    final abort = Completer<void>();
    StreamSubscription<HandrailStreamFrame>? subscription;
    late StreamController<HandrailStreamFrame> controller;
    var cancelled = false;
    controller = StreamController<HandrailStreamFrame>(
      onListen: () {
        final request = http.AbortableRequest(source.method, source.url,
            abortTrigger: abort.future)
          ..headers.addAll(source.headers)
          ..bodyBytes = source.bodyBytes
          ..followRedirects = false;
        subscription =
            _readStreamRequest(request, abort.future).listen((frame) {
          if (!cancelled) controller.add(frame);
        }, onError: (Object error, StackTrace stack) {
          if (!cancelled) controller.addError(error, stack);
        }, onDone: () {
          if (!cancelled) controller.close();
        });
      },
      onPause: () => subscription?.pause(),
      onResume: () => subscription?.resume(),
      onCancel: () async {
        cancelled = true;
        if (!abort.isCompleted) abort.complete();
        await subscription?.cancel();
      },
    );
    return controller.stream;
  }

  Stream<HandrailStreamFrame> _readStreamRequest(
      http.Request request, Future<void> aborted) async* {
    final operation = request.url.path;
    final started = DateTime.now();
    _diagnose(operation, 'started');
    try {
      Future<T> cancellable<T>(Future<T> operation) => Future.any([
            operation,
            aborted.then<T>((_) => throw http.RequestAbortedException()),
          ]);
      request.headers.addAll(await cancellable(_headers()));
      final response = await cancellable(_http.send(request));
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw HandrailGatewayException(
          'stream_request_failed',
          'Handrail gateway stream request failed.',
          retryable: response.statusCode >= 500 || response.statusCode == 429,
          statusCode: response.statusCode,
        );
      String? eventType, eventId;
      final data = <String>[];
      var sawTerminal = false;
      Map<String, Object?>? checkpoint;
      final expectsTerminal = operation.endsWith('/turns/start') ||
          operation.endsWith('/turns/resume');
      await for (final line in response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())) {
        if (line.isEmpty) {
          if (data.isNotEmpty) {
            final decoded =
                Map<String, Object?>.from(jsonDecode(data.join('\n')) as Map);
            final frame =
                HandrailStreamFrame(eventType ?? 'message', eventId, decoded);
            sawTerminal |= frame.type == 'terminal';
            if (decoded['checkpoint'] is Map)
              checkpoint =
                  Map<String, Object?>.from(decoded['checkpoint'] as Map);
            yield frame;
          }
          eventType = null;
          eventId = null;
          data.clear();
          continue;
        }
        if (line.startsWith(':')) continue;
        final colon = line.indexOf(':');
        final field = colon < 0 ? line : line.substring(0, colon);
        final value = colon < 0
            ? ''
            : line.substring(colon + 1).replaceFirst(RegExp(r'^ '), '');
        if (field == 'event')
          eventType = value;
        else if (field == 'id')
          eventId = value;
        else if (field == 'data') data.add(value);
      }
      if (expectsTerminal && !sawTerminal) {
        yield HandrailStreamFrame('terminal', null, {
          'type': 'terminal',
          'result': {
            'status': 'disconnected',
            if (checkpoint != null) 'checkpoint': checkpoint
          },
        });
      }
      _diagnose(
        operation,
        'succeeded',
        started: started,
        statusCode: response.statusCode,
      );
    } catch (error) {
      if (error is http.RequestAbortedException) {
        _diagnose(operation, 'cancelled', started: started);
        return;
      }
      _diagnose(
        operation,
        'failed',
        started: started,
        code: error is HandrailGatewayException
            ? error.code
            : error.runtimeType.toString(),
        retryable: error is HandrailGatewayException && error.retryable,
        statusCode: error is HandrailGatewayException ? error.statusCode : null,
      );
      rethrow;
    }
  }

  void _diagnose(
    String operation,
    String phase, {
    DateTime? started,
    String? code,
    bool? retryable,
    int? statusCode,
  }) {
    final sink = diagnostics;
    if (sink == null) return;
    try {
      sink(
        Map<String, Object?>.unmodifiable({
          'domain': 'gateway',
          'operation': operation,
          'phase': phase,
          'timestamp': DateTime.now().toUtc().toIso8601String(),
          if (started != null)
            'durationMs': DateTime.now().difference(started).inMilliseconds,
          if (code != null) 'code': code,
          if (retryable != null) 'retryable': retryable,
          if (statusCode != null) 'statusCode': statusCode,
        }),
      );
    } catch (_) {
      // Observability is non-authoritative.
    }
  }

  void _diagnoseFailure(String operation, DateTime started, Object error) {
    _diagnose(
      operation,
      'failed',
      started: started,
      code: error is HandrailGatewayException
          ? error.code
          : error.runtimeType.toString(),
      retryable: error is HandrailGatewayException && error.retryable,
      statusCode: error is HandrailGatewayException ? error.statusCode : null,
    );
  }

  Map<String, Object?> _success(http.Response response) {
    Map<String, Object?> body;
    try {
      body = Map<String, Object?>.from(jsonDecode(response.body) as Map);
    } catch (_) {
      throw HandrailGatewayException(
        'invalid_response',
        'Handrail gateway returned an invalid response.',
        retryable: response.statusCode >= 500,
        statusCode: response.statusCode,
      );
    }
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        body['ok'] != true) {
      final error = body['error'] is Map
          ? Map<String, Object?>.from(body['error'] as Map)
          : const <String, Object?>{};
      throw HandrailGatewayException(
        error['code'] as String? ?? 'request_failed',
        error['message'] as String? ?? 'Handrail gateway request failed.',
        retryable: error['retryable'] == true,
        statusCode: response.statusCode,
      );
    }
    return body;
  }

  void close() => _http.close();
}
