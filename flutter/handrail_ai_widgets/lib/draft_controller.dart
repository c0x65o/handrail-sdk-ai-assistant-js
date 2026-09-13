import 'package:flutter/widgets.dart';

/// A draft whose submission lifecycle is independent of response observation.
/// Create one per authenticated composer, and [reset] when its scope changes.
class HandrailDraftController extends TextEditingController {
  HandrailDraftController({String text = '', this.onDraftChanged})
      : _lastText = text,
        super(text: text) {
    addListener(_observeDraft);
  }

  final ValueChanged<String>? onDraftChanged;
  String _lastText;
  int _revision = 0;
  Object? _submission;
  _DraftAttempt? _pendingAttempt;
  bool _disposed = false;

  bool get isSubmitting => _submission != null;

  void _observeDraft() {
    if (_lastText == text) return;
    _lastText = text;
    _revision++;
    onDraftChanged?.call(text);
  }

  /// Captures one edit revision. Forward [accepted] to the SDK session's
  /// onAccepted callback; completion/failure never clears a newer draft.
  /// Returns null for a duplicate submission. Errors retain their original type.
  Future<T?> submit<T>(
      Future<T> Function(String text, VoidCallback accepted) send) async {
    if (_disposed || isSubmitting) return null;
    final attempt = _pendingAttempt = _DraftAttempt(_revision);
    final submittedText = text;
    return _execute(attempt, (accepted) => send(submittedText, accepted));
  }

  /// Reconciles the saved submission without treating the current draft as a
  /// new message. An unchanged original draft clears on admission; later edits
  /// and drafts restored without their original submission identity survive.
  Future<T?> retry<T>(Future<T> Function(VoidCallback accepted) send) async {
    if (_disposed || isSubmitting) return null;
    return _execute(_pendingAttempt, send);
  }

  Future<T?> _execute<T>(_DraftAttempt? attempt,
      Future<T> Function(VoidCallback accepted) send) async {
    final token = _submission = Object();
    var admitted = false;
    notifyListeners();
    try {
      return await send(() {
        if (_disposed || !identical(_submission, token) || admitted) return;
        admitted = true;
        if (attempt != null && identical(_pendingAttempt, attempt)) {
          _pendingAttempt = null;
          if (_revision == attempt.revision) clear();
        }
      });
    } finally {
      if (!_disposed && identical(_submission, token)) {
        _submission = null;
        notifyListeners();
      }
    }
  }

  /// Invalidates callbacks from the previous conversation/account immediately.
  void reset({String text = ''}) {
    if (_disposed) return;
    _submission = null;
    _pendingAttempt = null;
    _revision++;
    value = TextEditingValue(
        text: text, selection: TextSelection.collapsed(offset: text.length));
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _submission = null;
    _pendingAttempt = null;
    removeListener(_observeDraft);
    super.dispose();
  }
}

class _DraftAttempt {
  const _DraftAttempt(this.revision);
  final int revision;
}
