import 'package:flutter/foundation.dart';
import 'draft_controller.dart';

/// Account-scoped drafts and file selections, retained independently per chat.
/// Hosts supply attachment validation/upload and the authenticated send adapter.
/// Dispose this workspace when the authenticated account changes.
class HandrailComposerDrafts<TAttachment> extends ChangeNotifier {
  final _drafts = <String?, _ConversationDraft<TAttachment>>{};
  String? _selectedId;
  bool _disposed = false;

  String? get selectedId => _selectedId;
  _ConversationDraft<TAttachment> get _selected =>
      _drafts.putIfAbsent(_selectedId, () {
        final draft = _ConversationDraft<TAttachment>();
        draft.controller.addListener(_changed);
        return draft;
      });
  HandrailDraftController get controller => _selected.controller;
  List<TAttachment> get attachments =>
      List.unmodifiable(_selected.files.map((file) => file.value));
  bool get isSubmitting => controller.isSubmitting;
  Set<String> get draftConversationIds => Set.unmodifiable({
        for (final entry in _drafts.entries)
          if (entry.key != null && entry.value.hasDraft) entry.key!,
      });
  bool get hasOtherDrafts => _drafts.entries
      .any((entry) => entry.key != _selectedId && entry.value.hasDraft);

  void select(String? conversationId) {
    if (_disposed || _selectedId == conversationId) return;
    _selectedId = conversationId;
    _changed();
  }

  void discard(String? conversationId) {
    if (_disposed) return;
    _drafts.remove(conversationId)?.controller.dispose();
    _changed();
  }

  /// Clears unsent account content and invalidates all admission callbacks.
  void clear() {
    if (_disposed) return;
    for (final draft in _drafts.values) {
      draft.controller.dispose();
    }
    _drafts.clear();
    _changed();
  }

  void addAttachments(Iterable<TAttachment> values) {
    if (_disposed) return;
    _selected.files.addAll(values.map(_DraftFile.new));
    _changed();
  }

  void removeAttachmentAt(int index) {
    if (_disposed || index < 0 || index >= _selected.files.length) return;
    _selected.files.removeAt(index);
    _changed();
  }

  Future<TResult?> submit<TResult>(
      Future<TResult> Function(
              String text, List<TAttachment> attachments, VoidCallback accepted)
          send) async {
    if (_disposed || isSubmitting) return null;
    final draft = _selected;
    final files = draft.pendingFiles = List.of(draft.files);
    return _run(
        draft,
        (token) => draft.controller.submit((text, accepted) => send(
            text,
            List.unmodifiable(files.map((file) => file.value)),
            () => _acceptFiles(draft, files, token, accepted))));
  }

  Future<TResult?> retry<TResult>(
      Future<TResult> Function(VoidCallback accepted) send) async {
    if (_disposed || isSubmitting) return null;
    final draft = _selected;
    final files = draft.pendingFiles;
    return _run(
        draft,
        (token) => draft.controller.retry((accepted) =>
            send(() => _acceptFiles(draft, files, token, accepted))));
  }

  Future<TResult?> _run<TResult>(_ConversationDraft<TAttachment> draft,
      Future<TResult?> Function(Object token) operation) async {
    final token = draft.activeSubmission = Object();
    try {
      return await operation(token);
    } finally {
      if (identical(draft.activeSubmission, token))
        draft.activeSubmission = null;
    }
  }

  void _acceptFiles(
      _ConversationDraft<TAttachment> draft,
      List<_DraftFile<TAttachment>>? files,
      Object token,
      VoidCallback accepted) {
    if (_disposed ||
        !_drafts.containsValue(draft) ||
        !identical(draft.activeSubmission, token)) return;
    accepted();
    if (files != null && identical(draft.pendingFiles, files)) {
      draft.pendingFiles = null;
      // Remove exact selections. A removed/re-added identical file is a new
      // selection and must survive, just like an identical later text edit.
      draft.files.removeWhere(files.contains);
      _changed();
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final draft in _drafts.values) {
      draft.controller.dispose();
    }
    _drafts.clear();
    super.dispose();
  }
}

class _ConversationDraft<T> {
  final controller = HandrailDraftController();
  final files = <_DraftFile<T>>[];
  List<_DraftFile<T>>? pendingFiles;
  Object? activeSubmission;
  bool get hasDraft => controller.text.isNotEmpty || files.isNotEmpty;
}

class _DraftFile<T> {
  _DraftFile(this.value);
  final T value;
}
