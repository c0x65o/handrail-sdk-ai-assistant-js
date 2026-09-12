import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:handrail_ai_widgets/handrail_ai_widgets.dart';

void main() {
  for (final width in [320.0, 390.0, 768.0]) {
    testWidgets('draft starts above the aligned toolbar at $width',
        (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller =
          TextEditingController(text: 'Can we try with the initial');
      addTearDown(controller.dispose);
      var sent = 0;
      await tester.pumpWidget(MaterialApp(
          home: Scaffold(
              body: Padding(
        padding: const EdgeInsets.all(8),
        child: HandrailComposer(
            controller: controller,
            inputKey: const ValueKey('draft'),
            attachKey: const ValueKey('add'),
            sendKey: const ValueKey('send'),
            onAttach: () {},
            canSend: true,
            onSend: () => sent++,
            voiceControls: [
              IconButton(
                  onPressed: () {},
                  tooltip: 'Dictate',
                  icon: const Icon(Icons.mic_none))
            ]),
      ))));
      final draft = tester.getRect(find.byKey(const ValueKey('draft')));
      final add = tester.getRect(find.byKey(const ValueKey('add')));
      final send = tester.getRect(find.byKey(const ValueKey('send')));
      expect(draft.bottom, lessThan(add.top));
      expect((add.center.dy - send.center.dy).abs(), lessThanOrEqualTo(2));
      expect(draft.left, lessThan(add.center.dx));
      expect(send.right, lessThan(width));
      expect(add.width, greaterThanOrEqualTo(40));
      await tester.tap(find.byKey(const ValueKey('send')));
      expect(sent, 1);
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets(
      'host theme styles the shared composer and hides unavailable attachments',
      (tester) async {
    final controller = TextEditingController(text: 'Draft');
    addTearDown(controller.dispose);
    const decoration = BoxDecoration(color: Color(0xff291918));
    const textStyle = TextStyle(color: Colors.white, fontSize: 13);
    var sent = 0;
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: HandrailComposer(
      controller: controller,
      decoration: decoration,
      inputTextStyle: textStyle,
      sendButtonStyle: IconButton.styleFrom(
          backgroundColor: Colors.deepOrange,
          foregroundColor: Colors.white,
          minimumSize: const Size.square(48)),
      showAttachmentControl: false,
      showApprovalControl: false,
      voiceControls: const [],
      canSend: true,
      onSend: () => sent++,
    ))));
    expect(find.byTooltip('Add files and images'), findsNothing);
    expect(tester.widget<TextField>(find.byType(TextField)).style, textStyle);
    expect(
        find.byWidgetPredicate(
            (widget) => widget is Container && widget.decoration == decoration),
        findsOneWidget);
    final send = tester.widget<IconButton>(find.byType(IconButton));
    expect(send.style!.backgroundColor!.resolve({}), Colors.deepOrange);
    expect(send.style!.minimumSize!.resolve({}), const Size.square(48));
    await tester.tap(find.byType(IconButton));
    expect(sent, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('approval switch changes the next-message preference',
      (tester) async {
    var mode = HandrailApprovalMode.required;
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: HandrailApprovalBadge(
      mode: mode,
      onChanged: (next) => mode = next,
    ))));
    await tester.tap(find.byTooltip('Approval settings'));
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value,
        isFalse);
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    expect(mode, HandrailApprovalMode.automatic);
    expect(handrailApprovalMetadata(mode),
        {'handrail_approval_mode': 'automatic'});
  });
}
