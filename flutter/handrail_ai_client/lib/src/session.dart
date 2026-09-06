part of '../handrail_ai_client.dart';

Map<String, Object?> _object(Object? value) =>
    Map<String, Object?>.from(value as Map);
List<Map<String, Object?>> _records(Object? value) =>
    List.unmodifiable((value as List? ?? const [])
        .map((item) => Map<String, Object?>.unmodifiable(_object(item))));

/// The server's canonical transcript and state, independent of any SSE observer.
class HandrailConversationDocument {
  final String conversationId;
  final int? revision;
  final Map<String, Object?> state;
  final List<Map<String, Object?>> messages;
  final List<Map<String, Object?>> turns;
  const HandrailConversationDocument._(this.conversationId, this.revision,
      this.state, this.messages, this.turns);

  factory HandrailConversationDocument.fromSnapshot(
      String conversationId, Map<String, Object?> snapshot) {
    final state =
        _immutableJson(_object(snapshot['state'])) as Map<String, Object?>;
    if (snapshot['conversationId'] != conversationId ||
        state['conversation_id'] != conversationId ||
        state['replay_error'] != null ||
        snapshot['revision'] != state['revision']) {
      throw const HandrailGatewayException('invalid_snapshot',
          'The saved conversation could not be synchronized.');
    }
    final activeTurn = state['active_turn_id'];
    final turns = _records(state['turns']);
    if (activeTurn != null &&
        turns
                .where((turn) =>
                    turn['turn_id'] == activeTurn &&
                    turn['remote_may_still_be_running'] == true &&
                    const ['queued', 'running', 'waiting_for_tool_result']
                        .contains(turn['status']))
                .length !=
            1) {
      throw const HandrailGatewayException('invalid_snapshot',
          'The saved running conversation could not be synchronized.');
    }
    return HandrailConversationDocument._(
        conversationId,
        snapshot['revision'] as int?,
        Map.unmodifiable(state),
        _records(state['messages']),
        _records(state['turns']));
  }

  Map<String, Object?>? get latestTurn => turns.isEmpty ? null : turns.last;
  String? get activeTurnId {
    final id = state['active_turn_id'] as String?;
    if (id == null) return null;
    final active = turns.where((turn) => turn['turn_id'] == id);
    if (active.isEmpty || active.single['remote_may_still_be_running'] != true)
      return null;
    return id;
  }

  HandrailConversationState get runtimeState {
    final turn = latestTurn;
    final turnId = turn?['turn_id'] as String?;
    final outputIds =
        (turn?['output_message_ids'] as List? ?? const []).toSet();
    final output = messages.where((message) =>
        message['role'] == 'assistant' &&
        (message['turn_id'] == turnId ||
            outputIds.contains(message['message_id'])));
    final status = switch (turn?['status']) {
      'queued' || 'running' => HandrailTurnStatus.running,
      'waiting_for_tool_result' => HandrailTurnStatus.waitingForTool,
      'completed' => HandrailTurnStatus.completed,
      'cancelled' => HandrailTurnStatus.cancelled,
      'failed' => HandrailTurnStatus.failed,
      _ => HandrailTurnStatus.idle,
    };
    return HandrailConversationState(
        conversationId: conversationId,
        turnId: turnId,
        status: status,
        text: output
            .expand((message) => _records(message['content']))
            .where((part) => part['type'] == 'text')
            .map((part) => part['text'] as String)
            .join(),
        supersededTurnIds: Set.unmodifiable(turns
            .map((turn) => turn['turn_id'] as String)
            .where((id) => id != turnId)),
        toolCalls: _records(state['tool_calls'])
            .where((tool) => tool['turn_id'] == turnId)
            .toList(growable: false),
        approvals: _records(state['approval_proposals']),
        citations: _records(state['citations']),
        attachments: _records(state['attachments']));
  }
}

/// Shared reload/reconnect orchestration. Observation never creates another run.
/// Hosts own authentication and rendering; this session owns serialized recovery.
class HandrailConversationSession {
  final HandrailAiClient client;
  final String conversationId;
  final HandrailConversationWorkspace workspace;
  final Duration? pollingInterval;
  final bool synchronizeActivity;
  final bool _ownsWorkspace;
  final StreamController<HandrailConversationSession> _changes =
      StreamController.broadcast(sync: true);
  HandrailConversationDocument? _document;
  HandrailGatewayException? _error;
  HandrailGatewayCapabilities? _capabilities;
  Future<void>? _refreshing;
  Future<void>? _submitting;
  String? _submittingJson;
  Completer<void>? _startAcknowledgement;
  StreamSubscription<HandrailStreamFrame>? _observation;
  String? _observedTurnId;
  Map<String, Object?> _checkpoint = const {
    'lastAppliedEventId': null,
    'lastAppliedCursor': null,
    'lastAppliedRevision': null,
  };
  Timer? _timer;
  int _observationGeneration = 0;
  bool _disposed = false;

  HandrailConversationSession(
      {required this.client,
      required this.conversationId,
      HandrailConversationWorkspace? workspace,
      this.pollingInterval = const Duration(seconds: 1),
      this.synchronizeActivity = true})
      : workspace = workspace ?? HandrailConversationWorkspace(),
        _ownsWorkspace = workspace == null {
    if (pollingInterval != null &&
        pollingInterval! < const Duration(milliseconds: 100)) {
      throw ArgumentError.value(pollingInterval, 'pollingInterval');
    }
  }
  HandrailConversationDocument? get document => _document;
  HandrailGatewayException? get error => _error;
  bool get isRefreshing => _refreshing != null;
  bool get isSubmitting => _submitting != null;
  bool get observationConnected => _observation != null;
  Stream<HandrailConversationSession> get changes => _changes.stream;

  Future<void> initialize() async {
    try {
      await refresh();
    } finally {
      if (!_disposed &&
          _timer == null &&
          pollingInterval != null &&
          (_error == null || _error!.retryable)) {
        _timer = Timer.periodic(pollingInterval!, (_) {
          refresh().catchError((Object _) {});
        });
      }
    }
  }

  Future<void> refresh() {
    if (_disposed)
      return Future.error(StateError('Conversation session is disposed'));
    return _refreshing ??= _refresh().whenComplete(() {
      _refreshing = null;
    });
  }

  Future<void> _refresh() async {
    try {
      _capabilities ??= await client.capabilities();
      if (_disposed) return;
      if (!_capabilities!.synchronization)
        throw const HandrailGatewayException('synchronization_unavailable',
            'Saved conversation synchronization is unavailable.');
      var pull = _document == null;
      if (!pull) {
        final result = _value(await client.synchronize({
          'operation': 'read_since',
          'input': {
            'conversationId': conversationId,
            'afterRevision': _document!.revision,
          }
        }));
        if (_disposed) return;
        if (result['status'] == 'snapshot_required') {
          pull = true;
        } else if (result['status'] == 'events') {
          pull = (result['events'] as List).isNotEmpty ||
              result['hasMore'] == true;
        } else {
          throw _syncFailure(result);
        }
      }
      if (pull) {
        final result = _value(await client.synchronize({
          'operation': 'pull_snapshot',
          'input': {'conversationId': conversationId}
        }));
        if (_disposed) return;
        if (result['status'] != 'snapshot') throw _syncFailure(result);
        final document = HandrailConversationDocument.fromSnapshot(
            conversationId, _object(result['snapshot']));
        if (_document?.revision != null &&
            document.revision != null &&
            document.revision! < _document!.revision!) {
          throw const HandrailGatewayException('stale_snapshot',
              'Saved conversation synchronization is temporarily behind.',
              retryable: true);
        }
        _document = document;
        workspace.open(document.runtimeState,
            select: workspace.snapshot.selectedConversationId == null);
      }
      await _ensureObservation();
      if (_disposed) return;
      if (synchronizeActivity && _capabilities!.activity) {
        final records = await client.listActivity();
        if (_disposed) return;
        workspace.replaceRemoteActivity(records);
      }
      if (_disposed) return;
      _error = null;
      _publish();
    } catch (cause) {
      if (_disposed) return;
      _error = cause is HandrailGatewayException
          ? cause
          : const HandrailGatewayException('synchronization_failed',
              'Conversation synchronization is temporarily unavailable.',
              retryable: true);
      _publish();
      throw _error!;
    }
  }

  Future<void> _ensureObservation() async {
    if (_submitting != null) return;
    final active = _document?.activeTurnId;
    if (active == _observedTurnId && _observation != null) return;
    final changedTurn = active != _observedTurnId;
    await _disconnectObservation();
    if (_disposed || active == null) return;
    if (changedTurn)
      _checkpoint = const {
        'lastAppliedEventId': null,
        'lastAppliedCursor': null,
        'lastAppliedRevision': null
      };
    _observedTurnId = active;
    _observe(client.resumeTurn(
        conversationId: conversationId,
        turnId: active,
        resumeFrom: _checkpoint));
  }

  void _observe(Stream<HandrailStreamFrame> stream) {
    final generation = _observationGeneration;
    _observation = stream.listen((frame) {
      if (_disposed || generation != _observationGeneration) return;
      if (frame.type == 'started' &&
          _startAcknowledgement != null &&
          !_startAcknowledgement!.isCompleted) {
        if (frame.data['turnId'] != _observedTurnId ||
            frame.data['conversationId'] != conversationId) {
          _startAcknowledgement!.completeError(const HandrailGatewayException(
              'invalid_start', 'The server acknowledged a different turn.'));
        } else {
          _startAcknowledgement!.complete();
        }
      }
      final checkpoint = frame.data['checkpoint'] ??
          (frame.data['result'] is Map
              ? (frame.data['result'] as Map)['checkpoint']
              : null);
      if (checkpoint is Map)
        _checkpoint = Map.unmodifiable(_object(checkpoint));
      // Render canonical snapshots. Replayed SSE text must not be appended to
      // text already loaded from the server snapshot a second time.
    }, onError: (Object cause) {
      if (_disposed || generation != _observationGeneration) return;
      _observation = null;
      _error = cause is HandrailGatewayException
          ? cause
          : const HandrailGatewayException('observation_disconnected',
              'Reconnecting to the running conversation.',
              retryable: true);
      if (_startAcknowledgement != null && !_startAcknowledgement!.isCompleted)
        _startAcknowledgement!.completeError(_error!);
      _publish();
    }, onDone: () {
      if (_disposed || generation != _observationGeneration) return;
      _observation = null;
      if (_startAcknowledgement != null && !_startAcknowledgement!.isCompleted)
        _startAcknowledgement!.completeError(const HandrailGatewayException(
            'start_unconfirmed',
            'The send response was lost. Retry the saved message.',
            retryable: true));
      _publish();
    }, cancelOnError: true);
  }

  /// Prepare once with a globally unique operation ID. The host saves the result
  /// in account-scoped storage before calling [submitTurn]. No write occurs here.
  Future<HandrailTurnSubmission> prepareTurn({
    required String operationId,
    required String clientId,
    required Map<String, Object?> request,
  }) async {
    final immutableRequest = _immutableJson(request) as Map<String, Object?>;
    if (_submitting != null) throw StateError('A message is being submitted');
    await refresh();
    if (_disposed) throw StateError('Conversation session is disposed');
    if (_submitting != null || _document!.activeTurnId != null)
      throw const HandrailGatewayException('conversation_busy',
          'Wait for the running turn before sending another message.');
    return _prepareSubmission(
        conversationId: conversationId,
        revision: _document!.revision,
        operationId: operationId,
        clientId: clientId,
        request: immutableRequest);
  }

  /// Persists intent before any admission/start write. A failed/uncertain send
  /// retains its original IDs for [retryPendingMessage], including after reload.
  Future<HandrailTurnSubmission> sendMessage(
      {required String operationId,
      required String clientId,
      required Map<String, Object?> request,
      required HandrailPendingTurnStore pendingStore}) async {
    final submission = await prepareTurn(
        operationId: operationId, clientId: clientId, request: request);
    await pendingStore.retain(submission);
    await submitTurn(submission);
    await pendingStore.acknowledge(submission);
    return submission;
  }

  Future<HandrailTurnSubmission?> retryPendingMessage(
      HandrailPendingTurnStore pendingStore) async {
    final submission = await pendingStore.load(conversationId);
    if (submission == null) return null;
    await submitTurn(submission);
    await pendingStore.acknowledge(submission);
    return submission;
  }

  /// Acknowledges admission/start, not completion. Repeating an uncertain send
  /// requires the exact saved submission; the server deduplicates both writes.
  Future<void> submitTurn(HandrailTurnSubmission submission) {
    if (_disposed)
      return Future.error(StateError('Conversation session is disposed'));
    if (submission.conversationId != conversationId)
      return Future.error(
          ArgumentError('Submission belongs to another conversation'));
    final json = jsonEncode(submission.toJson());
    if (_submitting != null) {
      if (_submittingJson == json) return _submitting!;
      return Future.error(StateError('A different message is being submitted'));
    }
    _submittingJson = json;
    return _submitting = _submitTurn(submission).catchError((Object cause) {
      if (_disposed) throw cause;
      _error = cause is HandrailGatewayException
          ? cause
          : const HandrailGatewayException('send_unconfirmed',
              'The send response was lost. Retry the saved message.',
              retryable: true);
      _publish();
      throw _error!;
    }).whenComplete(() {
      _submitting = null;
      _submittingJson = null;
      _startAcknowledgement = null;
      _publish();
    });
  }

  Future<void> _submitTurn(HandrailTurnSubmission submission) async {
    await refresh();
    if (_disposed) throw StateError('Conversation session is disposed');
    final active = _document!.activeTurnId;
    if (active != null && active != submission.turnId)
      throw const HandrailGatewayException('conversation_busy',
          'Another turn is already running in this conversation.');
    final admitted = _value(await client.synchronize({
      'operation': 'append_mutations',
      'input': submission._admission,
    }));
    if (_disposed) throw StateError('Conversation session is disposed');
    if (admitted['status'] == 'conflict') {
      await refresh();
      throw const HandrailGatewayException('admission_conflict',
          'The conversation changed before this message was sent. Review it before sending again.');
    }
    if (admitted['status'] != 'mutations') throw _syncFailure(admitted);
    final acknowledgements = _records(admitted['acknowledgements']);
    final mutations = _records(submission._admission['mutations']);
    if (acknowledgements.length != mutations.length ||
        mutations.any((mutation) =>
            acknowledgements
                .where((ack) =>
                    ack['mutationId'] == mutation['mutationId'] &&
                    const ['accepted', 'duplicate'].contains(ack['status']))
                .length !=
            1)) {
      throw const HandrailGatewayException('admission_unconfirmed',
          'The message could not be confirmed. Retry the saved message.',
          retryable: true);
    }
    await refresh();
    if (_disposed) throw StateError('Conversation session is disposed');
    final turns =
        _document!.turns.where((turn) => turn['turn_id'] == submission.turnId);
    if (turns.length != 1)
      throw const HandrailGatewayException('admission_unconfirmed',
          'The saved message is not visible yet. Retry the saved message.',
          retryable: true);
    // A lost start acknowledgement can arrive after the run finished. Never
    // restart a canonical terminal turn, even if its transport record expired.
    if (const ['completed', 'cancelled', 'failed']
        .contains(turns.single['status'])) return;
    await _disconnectObservation();
    if (_disposed) throw StateError('Conversation session is disposed');
    _observedTurnId = submission.turnId;
    _checkpoint = const {
      'lastAppliedEventId': null,
      'lastAppliedCursor': null,
      'lastAppliedRevision': null
    };
    final acknowledgement = _startAcknowledgement = Completer<void>();
    _observe(client.startTurn(submission._start));
    await acknowledgement.future;
  }

  /// Requests server cancellation; status changes only after server confirmation.
  Future<void> requestCancellation(
      {required String mutationId, required String idempotencyKey}) async {
    if (_disposed) throw StateError('Conversation session is disposed');
    if (_document == null) await refresh();
    if (_capabilities?.authoritativeCancellation != true)
      throw const HandrailGatewayException(
          'cancellation_unavailable', 'Server cancellation is unavailable.');
    final turnId = _document?.activeTurnId;
    if (turnId == null) return;
    await client.cancelTurn({
      'conversationId': conversationId,
      'turnId': turnId,
      'mutationId': mutationId,
      'idempotencyKey': idempotencyKey,
      'reason': 'user'
    });
    if (!_disposed) await refresh();
  }

  Future<void> markRead() async {
    if (_disposed) throw StateError('Conversation session is disposed');
    final observed = workspace.remoteActivityFor(conversationId);
    if (observed == null || !observed.unread) return;
    final saved =
        await client.markActivityRead(conversationId, observed: observed);
    if (_disposed) return;
    if (saved != null) workspace.acceptRemoteActivity(saved);
    _publish();
  }

  Future<void> _disconnectObservation() async {
    if (_startAcknowledgement != null && !_startAcknowledgement!.isCompleted)
      _startAcknowledgement!
          .completeError(StateError('Turn observation was closed'));
    _observationGeneration++;
    final subscription = _observation;
    _observation = null;
    await subscription?.cancel();
  }

  void _publish() {
    if (!_disposed) _changes.add(this);
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _timer?.cancel();
    await _disconnectObservation();
    await _changes.close();
    if (_ownsWorkspace) await workspace.dispose();
  }
}

Map<String, Object?> _value(Map<String, Object?> result) =>
    _object(result['value']);
HandrailGatewayException _syncFailure(Map<String, Object?> result) =>
    HandrailGatewayException(
        'synchronization_${result['status'] == 'unauthorized' ? 'unauthorized' : 'unavailable'}',
        'The saved conversation is currently unavailable.',
        retryable: result['status'] != 'unauthorized');

Object? _immutableJson(Object? value) {
  if (value is Map)
    return Map<String, Object?>.unmodifiable(value
        .map((key, child) => MapEntry(key as String, _immutableJson(child))));
  if (value is List)
    return List<Object?>.unmodifiable(value.map(_immutableJson));
  return value;
}
