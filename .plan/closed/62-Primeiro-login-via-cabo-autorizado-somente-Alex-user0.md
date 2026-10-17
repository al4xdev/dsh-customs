# First local login authorized via cable

The owner explicitly authorized passing the private link to the app via local ADB over cable, overriding the previous restriction for this one-time action.

1. Verify serial ZY22F2395W and current user 0; do not install/launch anything on Work 10.
2. Read `connection.json` strictly within an in-memory local helper, validating private/owned file and exact HTTPS URL on port 8443. Do not return token/link to model, stdout, logs, clipboard, or any new file.
3. Inspect UI hierarchy in memory, without screenshots or persisted dumps; return only necessary state and bounds. Focus masked field and pass link via ADB stdin, never host command arguments; perform only explicit login.
4. Verify only authenticated state/list using sanitized UI metadata, without chats/messages/sends/approvals. Do not capture private content; do not modify TTL/profile/service/publication.
5. Reopen/force-stop test requires confirming no pending send; do not perform during this login action. Record result without secrets and keep goal active until complete validation.
