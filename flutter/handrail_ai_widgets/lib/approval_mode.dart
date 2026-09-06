/// A per-message preference. The server still enforces the signed-in actor's permissions.
enum HandrailApprovalMode { required, automatic }

Map<String, Object?> handrailApprovalMetadata(HandrailApprovalMode mode) =>
    {'handrail_approval_mode': mode.name};
