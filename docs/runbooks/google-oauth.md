# Google OAuth runbook

This runbook operates optional Gmail onboarding for the pinned Hypermail v0.7.26 integration. It uses the authorization-code flow with PKCE and offline access, and requests only `https://www.googleapis.com/auth/gmail.modify`. Outlook continues to use Hypermail v0.7.26's built-in public client and is out of scope.

## Test project and client

Use a dedicated **test** Google Cloud project; do not reuse it for production.

1. Create the project under the organization and enable Gmail API access:

   ```sh
   gcloud projects create "$GOOGLE_PROJECT_ID" --organization="$GOOGLE_ORG_ID"
   gcloud services enable gmail.googleapis.com --project="$GOOGLE_PROJECT_ID"
   ```

2. In Google Cloud Console, use **Google Auth Platform** to configure Branding, Audience, Data Access, named test users, and a Web application OAuth client. These are current Console-only consumer OAuth operations. Do **not** use `gcloud iam oauth-clients`: it configures IAM/Workforce OAuth clients and is not the Gmail consumer OAuth client workflow.
3. Set Audience to **External** and publishing status to **Testing**. Add each authorized test account by name/email; Testing is limited to 100 test users. Test non-basic-scope grants, including refresh-token access, expire after seven days, so re-authorize during acceptance as needed.
4. In Data Access, add **only** the restricted scope `https://www.googleapis.com/auth/gmail.modify`. The restricted-scope/test-user warning is expected during testing; do not add scopes merely to remove it.
5. Create the Web client with this exact authorized redirect URI for local work:

   ```text
   http://localhost:8080/oauth/gmail/callback
   ```

   Do not add a JavaScript authorized origin: this is a server-side authorization-code callback flow. The public web application owns the same-origin callback, while private Hypermail performs the integration and must receive the client configuration.

## Capture and local configuration

Download or capture the issued client secret once. Never print it, commit it, put it in a ticket or log, include it in a browser snapshot, or leave the downloaded credential artifact behind. Put the ID, issued optional secret, and exact redirect URI in ignored local `.env` only, then restrict it:

```sh
chmod 0600 .env
```

Local Compose sends `HYPERMAIL_GMAIL_CLIENT_ID`, optional `HYPERMAIL_GMAIL_CLIENT_SECRET`, and `HYPERMAIL_GMAIL_REDIRECT_URI` only to private Hypermail; it blanks them for web, worker, and migrate. Web must not receive Google credentials even though it owns the public callback. Hypermail has no published host port: it joins the internal network for MCP traffic and the outbound-only `egress` network because Google token exchange and Gmail API calls otherwise fail at the provider boundary.

For a client change or secret rotation, first add/update the Google registration and update the Hypermail configuration, then redeploy or restart Hypermail and validate sanitized readiness plus an authorized flow. Revoke the previous secret only afterward, so a failed rollout does not strand onboarding.

## Isolated test acceptance

Use an isolated Gmail test account, not a personal or production mailbox. Keep the worker and all autonomy stopped while performing OAuth acceptance. Authorize the named test user, complete the callback, and confirm onboarding without exposing token, authorization code, client secret, or rendered environment data. A Compose render only proves credential delivery boundaries; it does not prove Google OAuth works.

## Production follow-up

Test proof is not production readiness. Production requires a separate Google project and client, an owned HTTPS domain with its exact callback URI, public homepage and privacy-policy URLs, and a verified domain. Complete Google's OAuth verification with scope justification and any required demo. Because `gmail.modify` is restricted, expect the restricted-scope security assessment process as applicable before production use.

Keep the production client ID, optional secret, and redirect URI only in Hypermail's deployment secret/env file (`HYPERMAIL_ENV_FILE`), never a shared application file. Apply the same rotation order above.

## Official references

- [Google Auth Platform setup](https://support.google.com/cloud/answer/15544987?hl=en)
- [Google Auth Platform OAuth clients](https://support.google.com/cloud/answer/15549257?hl=en)
- [Google Auth Platform audience and test users](https://support.google.com/cloud/answer/15549945?hl=en)
- [Google Auth Platform data access and verification](https://support.google.com/cloud/answer/15549135?hl=en)
- [Gmail API OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google OAuth production-readiness policy compliance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
