import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:handrail_ai_widgets/attachment_preview.dart';

void main() {
  final png = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
  Widget preview(String id, Future<Uint8List> Function() load) => MaterialApp(
      home: Scaffold(
          body: HandrailAttachmentPreview(
              attachmentId: id,
              label: 'Membership photo',
              mediaType: 'image/png',
              loadBytes: load)));
  testWidgets(
      'retries a failed authorized image load without exposing the exception',
      (tester) async {
    var calls = 0;
    await tester.pumpWidget(preview('scope/photo', () async {
      if (++calls == 1) throw Exception('private server detail');
      return png;
    }));
    await tester.pumpAndSettle();
    expect(find.textContaining('private server'), findsNothing);
    expect(find.text('Preview unavailable. Try again'), findsOneWidget);
    await tester.tap(find.text('Preview unavailable. Try again'));
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(find.byType(Image), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('ignores an old scope load after switching and after disposal',
      (tester) async {
    final old = Completer<Uint8List>(), current = Completer<Uint8List>();
    await tester.pumpWidget(preview('old/photo', () => old.future));
    await tester.pumpWidget(preview('new/photo', () => current.future));
    old.complete(png);
    await tester.pump();
    expect(find.byType(Image), findsNothing);
    await tester.pumpWidget(const SizedBox());
    current.complete(png);
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
