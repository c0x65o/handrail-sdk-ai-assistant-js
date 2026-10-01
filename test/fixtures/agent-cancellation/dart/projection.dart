import 'package:handrail_ai_client/handrail_ai_client.dart';

Future<void> main(List<String> args) async {
  final client = HandrailAiClient(baseUri: Uri.parse(args[0]));
  final session = HandrailConversationSession(
      client: client, conversationId: args[1], pollingInterval: null);
  try {
    await session.initialize();
    await session.refresh();
    final turn = session.document!.turns
        .singleWhere((turn) => turn['turn_id'] == args[2]);
    if (turn['status'] != args[3] ||
        turn['remote_may_still_be_running'] != false ||
        session.document!.activeTurnId != null) {
      throw StateError('Fresh Dart session did not converge: $turn');
    }
    final capability = (await client.capabilities()).displayHistory!;
    final control = await client.displayHistoryControl(
        conversationId: args[1], capability: capability, turnId: args[2]);
    if (control.requestedTurn?.status != args[3] ||
        control.requestedTurn?.remoteMayStillBeRunning != false) {
      throw StateError('Dart control projection did not converge');
    }
    print('Fresh Dart process: ${args[3]}, remoteMayBeRunning=false');
  } finally {
    await session.dispose();
    client.close();
  }
}
