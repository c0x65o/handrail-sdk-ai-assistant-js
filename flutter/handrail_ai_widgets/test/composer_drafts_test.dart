import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:handrail_ai_widgets/handrail_ai_widgets.dart';

void main() {
  test('admission clears only submitted selections in their own chat',
      () async {
    final drafts = HandrailComposerDrafts<String>();
    addTearDown(drafts.dispose);
    drafts.select('one');
    drafts.controller.text = 'question';
    drafts.addAttachments(['same.pdf']);
    late void Function() accepted;
    final response = Completer<void>();
    final sending = drafts.submit((text, files, callback) {
      expect(text, 'question');
      expect(files, ['same.pdf']);
      accepted = callback;
      return response.future;
    });
    drafts.removeAttachmentAt(0);
    drafts.addAttachments(['same.pdf', 'later.png']);
    drafts.controller.text = 'edited';
    drafts.controller.text = 'question';
    drafts.select('two');
    drafts.controller.text = 'other chat';
    accepted();
    expect(drafts.controller.text, 'other chat');
    drafts.select('one');
    expect(drafts.controller.text, 'question');
    expect(drafts.attachments, ['same.pdf', 'later.png']);
    response.complete();
    await sending;
    expect(drafts.draftConversationIds, {'one', 'two'});
    expect(drafts.hasOtherDrafts, isTrue);
  });

  test('failed upload keeps text/files; retry admission clears original only',
      () async {
    final drafts = HandrailComposerDrafts<String>();
    addTearDown(drafts.dispose);
    drafts.controller.text = 'question';
    drafts.addAttachments(['first.pdf']);
    late void Function() oldAccepted;
    await expectLater(drafts.submit((_, __, accepted) async {
      oldAccepted = accepted;
      throw StateError('Upload failed');
    }), throwsStateError);
    oldAccepted();
    expect(drafts.controller.text, 'question');
    expect(drafts.attachments, ['first.pdf']);
    drafts.addAttachments(['next.pdf']);
    await drafts.retry((accepted) async {
      oldAccepted();
      expect(drafts.attachments, ['first.pdf', 'next.pdf']);
      accepted();
    });
    expect(drafts.controller.text, isEmpty);
    expect(drafts.attachments, ['next.pdf']);
  });

  test('discard and dispose invalidate background admission safely', () async {
    final drafts = HandrailComposerDrafts<String>();
    drafts.select('one');
    drafts.controller.text = 'question';
    final response = Completer<void>();
    late void Function() accepted;
    final sending = drafts.submit((_, __, callback) {
      accepted = callback;
      return response.future;
    });
    drafts.discard('one');
    drafts.controller.text = 'new draft';
    accepted();
    expect(drafts.controller.text, 'new draft');
    drafts.dispose();
    accepted();
    response.complete();
    await sending;
  });
}
