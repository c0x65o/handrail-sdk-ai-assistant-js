import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pasteboard/pasteboard.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'approval_mode.dart';

export 'approval_mode.dart';

class HandrailClipboardImage {
  const HandrailClipboardImage(this.bytes, this.mediaType, this.filename);
  final Uint8List bytes;
  final String mediaType;
  final String filename;
  static Future<HandrailClipboardImage?> read() async {
    final bytes = await Pasteboard.image;
    if (bytes == null || bytes.isEmpty) return null;
    if (bytes.length > 20 * 1024 * 1024)
      throw StateError('Clipboard image is too large. Choose a smaller image.');
    final type = bytes.length >= 8 &&
            bytes[0] == 137 &&
            bytes[1] == 80 &&
            bytes[2] == 78 &&
            bytes[3] == 71
        ? ('image/png', 'png')
        : bytes.length >= 3 &&
                bytes[0] == 255 &&
                bytes[1] == 216 &&
                bytes[2] == 255
            ? ('image/jpeg', 'jpg')
            : bytes.length >= 12 &&
                    String.fromCharCodes(bytes.sublist(0, 4)) == 'RIFF' &&
                    String.fromCharCodes(bytes.sublist(8, 12)) == 'WEBP'
                ? ('image/webp', 'webp')
                : bytes.length >= 6 &&
                        String.fromCharCodes(bytes.sublist(0, 3)) == 'GIF'
                    ? ('image/gif', 'gif')
                    : null;
    if (type == null)
      throw StateError('This clipboard image format is not supported.');
    return HandrailClipboardImage(bytes, type.$1, 'pasted-image.${type.$2}');
  }
}

class HandrailApprovalBadge extends StatelessWidget {
  const HandrailApprovalBadge(
      {super.key,
      this.mode = HandrailApprovalMode.required,
      this.onChanged,
      this.enabled = true});
  final HandrailApprovalMode mode;
  final ValueChanged<HandrailApprovalMode>? onChanged;
  final bool enabled;
  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: 'Approval settings',
        style: const ButtonStyle(
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            padding: WidgetStatePropertyAll(EdgeInsets.all(8)),
            backgroundColor: WidgetStatePropertyAll(Colors.transparent)),
        constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
        color: mode == HandrailApprovalMode.automatic
            ? const Color(0xff202124)
            : const Color(0xff999999),
        icon: Icon(
            mode == HandrailApprovalMode.automatic
                ? Icons.shield
                : Icons.shield_outlined,
            size: 18),
        onPressed: () {
          var selected = mode;
          showModalBottomSheet<void>(
              context: context,
              showDragHandle: true,
              builder: (context) => SafeArea(
                    child: StatefulBuilder(
                        builder: (context, update) => Padding(
                              padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                              child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    SwitchListTile.adaptive(
                                        contentPadding: EdgeInsets.zero,
                                        title:
                                            const Text('Auto-approve changes'),
                                        value: selected ==
                                            HandrailApprovalMode.automatic,
                                        onChanged: !enabled || onChanged == null
                                            ? null
                                            : (value) {
                                                selected = value
                                                    ? HandrailApprovalMode
                                                        .automatic
                                                    : HandrailApprovalMode
                                                        .required;
                                                onChanged!(selected);
                                                update(() {});
                                              }),
                                    Text(selected ==
                                            HandrailApprovalMode.automatic
                                        ? 'Add, edit, and delete without asking each time, within your account permissions.'
                                        : 'Review and approve additions, edits, and deletions before they run.'),
                                    const SizedBox(height: 12),
                                    Text(onChanged == null
                                        ? 'Approval settings are managed by this application.'
                                        : 'Applies to your next message. Changes already running keep their original setting.'),
                                  ]),
                            )),
                  ));
        },
      );
}

class _PasteImageIntent extends Intent {
  const _PasteImageIntent();
}

/// Shared two-row composer. Hosts keep attachment upload, permissions, and submission ownership.
class HandrailComposer extends StatefulWidget {
  const HandrailComposer(
      {super.key,
      required this.controller,
      this.input,
      this.onChanged,
      this.placeholder = 'Message…',
      this.maxLength,
      this.onAttach,
      this.attachKey,
      this.inputKey,
      this.sendKey,
      this.onSend,
      this.onStop,
      this.canSend = false,
      this.enabled = true,
      this.sending = false,
      this.approvalMode = HandrailApprovalMode.required,
      this.onApprovalModeChanged,
      this.showApprovalControl = true,
      this.voiceControls,
      this.onPasteImage,
      this.onVoiceBusyChanged});
  final TextEditingController controller;
  final Widget? input;
  final ValueChanged<String>? onChanged;
  final String placeholder;
  final int? maxLength;
  final Key? attachKey, inputKey, sendKey;
  final VoidCallback? onAttach, onSend, onStop;
  final bool canSend, enabled, sending, showApprovalControl;
  final HandrailApprovalMode approvalMode;
  final ValueChanged<HandrailApprovalMode>? onApprovalModeChanged;
  final List<Widget>? voiceControls;
  final FutureOr<void> Function(HandrailClipboardImage)? onPasteImage;
  final ValueChanged<bool>? onVoiceBusyChanged;
  @override
  State<HandrailComposer> createState() => _HandrailComposerState();
}

class _HandrailComposerState extends State<HandrailComposer> {
  bool _dictating = false;
  Future<void> _paste({bool textFallback = false}) async {
    if (!widget.enabled || widget.sending) return;
    try {
      HandrailClipboardImage? image;
      try {
        image = await HandrailClipboardImage.read();
      } catch (_) {
        if (!textFallback) rethrow;
      }
      if (!mounted || !widget.enabled || widget.sending) return;
      if (image != null) {
        await widget.onPasteImage?.call(image);
        return;
      }
      if (textFallback) {
        final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
        if (!mounted || !widget.enabled || widget.sending || text == null)
          return;
        final value = widget.controller.value;
        final start =
            value.selection.isValid ? value.selection.start : value.text.length;
        final end =
            value.selection.isValid ? value.selection.end : value.text.length;
        final updated = value.text.replaceRange(start, end, text);
        if (widget.maxLength != null && updated.length > widget.maxLength!) {
          throw StateError('Pasted text exceeds the message limit.');
        }
        widget.controller.value = TextEditingValue(
            text: updated,
            selection: TextSelection.collapsed(offset: start + text.length));
        widget.onChanged?.call(updated);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('No image on the clipboard.')));
      }
    } catch (_) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text(
                'The clipboard image could not be pasted. Try adding it as a file.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget input = widget.input ??
        TextField(
          key: widget.inputKey,
          controller: widget.controller,
          enabled: widget.enabled,
          minLines: 1,
          maxLines: 6,
          maxLength: widget.maxLength,
          keyboardType: TextInputType.multiline,
          textInputAction: TextInputAction.newline,
          textCapitalization: TextCapitalization.sentences,
          style: const TextStyle(
              color: Color(0xff202124), fontSize: 15, height: 1.4),
          decoration: InputDecoration(
              hintText: widget.placeholder,
              counterText: '',
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              isCollapsed: true,
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 4, vertical: 2)),
          onChanged: widget.onChanged,
          contextMenuBuilder: (context, editable) =>
              AdaptiveTextSelectionToolbar.buttonItems(
                  anchors: editable.contextMenuAnchors,
                  buttonItems: [
                ...editable.contextMenuButtonItems,
                if (widget.onPasteImage != null)
                  ContextMenuButtonItem(
                      label: 'Paste image',
                      onPressed: () {
                        ContextMenuController.removeAny();
                        unawaited(_paste());
                      })
              ]),
        );
    if (widget.onPasteImage != null) {
      input = Shortcuts(
          shortcuts: const <ShortcutActivator, Intent>{
            SingleActivator(LogicalKeyboardKey.keyV, control: true):
                _PasteImageIntent(),
            SingleActivator(LogicalKeyboardKey.keyV, meta: true):
                _PasteImageIntent(),
          },
          child: Actions(actions: <Type, Action<Intent>>{
            _PasteImageIntent: CallbackAction<_PasteImageIntent>(onInvoke: (_) {
              unawaited(_paste(textFallback: true));
              return null;
            }),
          }, child: input));
    }
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: const Color(0xffe9e9e9)),
          borderRadius: BorderRadius.circular(16),
          boxShadow: const [
            BoxShadow(
                color: Color(0x08000000), blurRadius: 18, offset: Offset(0, 4))
          ]),
      child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 26), child: input),
            const SizedBox(height: 4),
            Row(children: [
              IconButton(
                  key: widget.attachKey,
                  tooltip: 'Add files and images',
                  style: const ButtonStyle(
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      padding: WidgetStatePropertyAll(EdgeInsets.all(8)),
                      backgroundColor:
                          WidgetStatePropertyAll(Colors.transparent)),
                  onPressed: widget.enabled && !widget.sending && !_dictating
                      ? widget.onAttach
                      : null,
                  icon: const Icon(Icons.add_rounded, size: 22),
                  constraints:
                      const BoxConstraints(minWidth: 40, minHeight: 40)),
              if (widget.showApprovalControl)
                HandrailApprovalBadge(
                    mode: widget.approvalMode,
                    onChanged: widget.onApprovalModeChanged,
                    enabled: widget.enabled && !widget.sending),
              const Spacer(),
              ...?widget.voiceControls,
              if (widget.voiceControls == null)
                HandrailDictationButton(
                    controller: widget.controller,
                    enabled: widget.enabled && !widget.sending,
                    onChanged: widget.onChanged,
                    onBusyChanged: (busy) {
                      setState(() => _dictating = busy);
                      widget.onVoiceBusyChanged?.call(busy);
                    }),
              const SizedBox(width: 4),
              IconButton.filled(
                  key: widget.sendKey,
                  tooltip: widget.onStop != null && widget.sending
                      ? 'Stop response'
                      : 'Send message',
                  style: IconButton.styleFrom(
                      fixedSize: const Size.square(40),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      shape: const CircleBorder(),
                      backgroundColor: const Color(0xff55b653),
                      foregroundColor: Colors.white),
                  onPressed: widget.sending && widget.onStop != null
                      ? widget.onStop
                      : widget.enabled &&
                              widget.canSend &&
                              !widget.sending &&
                              !_dictating
                          ? widget.onSend
                          : null,
                  icon: Icon(
                      widget.sending && widget.onStop != null
                          ? Icons.stop_rounded
                          : Icons.arrow_upward_rounded,
                      size: 20)),
            ]),
          ]),
    );
  }
}

/// Device speech recognition; microphone permission is requested only on tap.
class HandrailDictationButton extends StatefulWidget {
  const HandrailDictationButton(
      {super.key,
      required this.controller,
      this.enabled = true,
      this.onChanged,
      this.onBusyChanged});
  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String>? onChanged;
  final ValueChanged<bool>? onBusyChanged;
  @override
  State<HandrailDictationButton> createState() =>
      _HandrailDictationButtonState();
}

class _HandrailDictationButtonState extends State<HandrailDictationButton> {
  final _speech = SpeechToText();
  bool _busy = false;
  int _generation = 0;
  void _setBusy(bool value) {
    if (mounted && _busy != value) {
      setState(() => _busy = value);
      widget.onBusyChanged?.call(value);
    }
  }

  @override
  void dispose() {
    _generation++;
    unawaited(_speech.cancel());
    super.dispose();
  }

  @override
  void didUpdateWidget(HandrailDictationButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(widget.controller, oldWidget.controller) ||
        !widget.enabled && oldWidget.enabled) {
      _generation++;
      unawaited(_speech.cancel());
      if (_busy) {
        _busy = false;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) widget.onBusyChanged?.call(false);
        });
      }
    }
  }

  Future<void> _start() async {
    if (!widget.enabled || _busy) return;
    final generation = ++_generation;
    _setBusy(true);
    try {
      final ready = await _speech.initialize(onStatus: (status) {
        if (generation == _generation && status == 'done') _setBusy(false);
      }, onError: (_) {
        if (generation != _generation) return;
        _setBusy(false);
        _notice();
      });
      if (!mounted || generation != _generation) return;
      if (!ready) {
        _setBusy(false);
        _notice();
        return;
      }
      await _speech.listen(
          listenOptions: SpeechListenOptions(
              listenFor: const Duration(seconds: 60),
              partialResults: false,
              cancelOnError: true,
              listenMode: ListenMode.dictation),
          onResult: (result) {
            if (!mounted || generation != _generation || !result.finalResult)
              return;
            final words = result.recognizedWords.trim();
            if (words.isEmpty) return;
            final text = [widget.controller.text.trimRight(), words]
                .where((part) => part.isNotEmpty)
                .join(' ');
            widget.controller.value = TextEditingValue(
                text: text,
                selection: TextSelection.collapsed(offset: text.length));
            widget.onChanged?.call(text);
          });
    } catch (_) {
      _setBusy(false);
      _notice();
    }
  }

  void _notice() {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'Voice input is unavailable. Check microphone and speech permissions, or use keyboard dictation.')));
  }

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: _busy ? 'Stop dictation' : 'Dictate a message',
        style: const ButtonStyle(
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            padding: WidgetStatePropertyAll(EdgeInsets.all(8)),
            backgroundColor: WidgetStatePropertyAll(Colors.transparent)),
        onPressed: _busy
            ? () async {
                try {
                  await _speech.stop();
                } catch (_) {
                  _notice();
                } finally {
                  _setBusy(false);
                }
              }
            : widget.enabled
                ? _start
                : null,
        color: _busy ? Colors.red : const Color(0xff202124),
        constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
        icon: Icon(_busy ? Icons.stop_circle_outlined : Icons.mic_none_rounded,
            size: 20),
      );
}
