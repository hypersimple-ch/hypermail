# Android Chrome PWA checklist — Phase 8 execution required

**Status: UNEXECUTED.** Phase 6 supplies deployable static assets and a standards-based worker, but this workspace has no browser host or production URL. Do not mark any item passed until it is exercised on a real Android Chrome device over HTTPS.

- [ ] Open the deployed app in Android Chrome and verify `manifest.webmanifest` is accepted, including 192px and 512px `any maskable` icons.
- [ ] Use Chrome’s **Install app** menu action; launch from the Android launcher and verify standalone display, name, theme color, and icon safe area.
- [ ] Deploy a changed worker, keep an old client open, and verify it remains active until the visible **Reload to update** action sends `SKIP_WAITING`; verify the reload uses the new worker.
- [ ] Trigger notification permission only from the explicit in-app control; verify granted, denied, and unsupported states. Denied/unavailable must use the persistent in-app badge fallback without repeat prompts.
- [ ] Send a production redacted push payload. Verify title/body contain only sender, subject, and status; tap it and verify it opens `/activities/{encoded activityId}` in the installed app.
- [ ] Verify the badge fallback appears and clears when its corresponding activity is viewed; do not infer Android launcher badge support from this fallback.
- [ ] With network available, directly open an Activity deep link and verify the host serves the application route.
- [ ] Turn on airplane mode and navigate to any document route. Verify only the generic offline page appears; verify no mail/body/attachment content is available and no write/action is queued. Restore connectivity and reload.
- [ ] With Android’s Reduce motion enabled, verify install/update/badge UI uses no nonessential animation and remains understandable.
