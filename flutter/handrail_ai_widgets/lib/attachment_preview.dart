import 'dart:typed_data';
import 'package:flutter/material.dart';

/// The host loads bytes through its authenticated API. No credentials, signed
/// URLs, or local picker paths are stored in the conversation or widget.
class HandrailAttachmentPreview extends StatefulWidget {
  const HandrailAttachmentPreview(
      {super.key,
      required this.attachmentId,
      required this.label,
      required this.mediaType,
      required this.loadBytes,
      this.onOpen});

  /// Include the conversation/account scope when constructing this identity.
  final String attachmentId;
  final String label;
  final String mediaType;
  final Future<Uint8List> Function() loadBytes;
  final VoidCallback? onOpen;
  @override
  State<HandrailAttachmentPreview> createState() =>
      _HandrailAttachmentPreviewState();
}

class _HandrailAttachmentPreviewState extends State<HandrailAttachmentPreview> {
  Uint8List? _bytes;
  bool _failed = false;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(HandrailAttachmentPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.attachmentId != widget.attachmentId ||
        oldWidget.mediaType != widget.mediaType) {
      _release();
      _failed = false;
      _load();
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    if (!widget.mediaType.startsWith('image/')) return;
    try {
      final bytes = await widget.loadBytes();
      if (!mounted || generation != _generation) return;
      if (bytes.isEmpty) throw const FormatException('Empty attachment');
      setState(() {
        _bytes = Uint8List.fromList(bytes);
        _failed = false;
      });
    } catch (_) {
      if (mounted && generation == _generation) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    _generation++;
    _release();
    super.dispose();
  }

  void _release() {
    final bytes = _bytes;
    if (bytes != null)
      PaintingBinding.instance.imageCache.evict(MemoryImage(bytes));
    _bytes = null;
  }

  @override
  Widget build(BuildContext context) {
    return Card(
        clipBehavior: Clip.antiAlias,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (widget.mediaType.startsWith('image/'))
            SizedBox(
                height: 160,
                width: double.infinity,
                child: _failed
                    ? _unavailable()
                    : _bytes == null
                        ? const Center(
                            child: CircularProgressIndicator(
                                semanticsLabel: 'Loading image'))
                        : Image.memory(_bytes!,
                            fit: BoxFit.contain,
                            semanticLabel: '${widget.label} preview',
                            errorBuilder: (_, __, ___) => _unavailable())),
          ListTile(
              title: Text(widget.label),
              trailing: widget.onOpen == null
                  ? null
                  : IconButton(
                      onPressed: widget.onOpen,
                      tooltip: 'Open attachment',
                      icon: const Icon(Icons.open_in_new))),
        ]));
  }

  Widget _unavailable() => Center(
          child: TextButton.icon(
        icon: const Icon(Icons.refresh),
        label: const Text('Preview unavailable. Try again'),
        onPressed: () {
          setState(() {
            _failed = false;
            _release();
          });
          _load();
        },
      ));
}
