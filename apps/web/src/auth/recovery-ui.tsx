import { useState } from 'react';
import type { SubmitEvent } from 'react'
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardHeader } from '@/components/heroui/card.js';
import { Field, FieldLabel, FieldSet } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { Spinner } from '@/components/heroui/spinner.js';

export type RecoveryApi = Readonly<{ request(email: string): Promise<void>; reset(token: string, password: string): Promise<boolean> }>;
/** Called once on entry before rendering any network-backed surface. Token never enters query/logs. */
export function consumeRecoveryFragment(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  window.history.replaceState(null, '', window.location.pathname);
  return token;
}
export function ForgotPasswordSurface({ api, onLogin }: { api: RecoveryApi; onLogin: () => void }) {
  const [email, setEmail] = useState(''); const [pending, setPending] = useState(false); const [sent, setSent] = useState(false); const [error, setError] = useState(false);
  async function submit(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (pending) return; setPending(true); setError(false); try { await api.request(email); setSent(true); } catch { setError(true); } finally { setPending(false); } }
  return <main className="grid min-h-dvh place-items-center bg-background p-4" aria-labelledby="recovery-title">
    <Card className="w-full max-w-md"><CardHeader><h1 id="recovery-title" className="text-2xl font-semibold tracking-tight">Forgot your password?</h1></CardHeader><CardContent>
      {sent ? <p>If an account exists for that email, a reset message will be delivered. Check your inbox.</p> : <form onSubmit={event => { void submit(event); }}><FieldSet disabled={pending}>
        <Field><FieldLabel htmlFor="recovery-email">Email</FieldLabel><Input id="recovery-email" name="email" autoComplete="email" type="email" required value={email} onChange={event => { setEmail(event.target.value); }} /></Field>
        <Button type="submit" disabled={pending}>{pending ? <><Spinner />Requesting…</> : 'Request reset link'}</Button>
      </FieldSet></form>}
      {error && <p role="alert">Unable to request a reset right now. Try again later.</p>}
      <Button type="button" variant="ghost" onClick={onLogin}>Back to login</Button>
    </CardContent></Card>
  </main>;
}
export function ResetPasswordSurface({ api, token, onLogin }: { api: RecoveryApi; token: string | null; onLogin: () => void }) {
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [pending, setPending] = useState(false); const [done, setDone] = useState(false); const [error, setError] = useState<string | null>(token ? null : 'This reset link is invalid, expired, or already used.');
  async function submit(event: SubmitEvent<HTMLFormElement>) { event.preventDefault(); if (!token || pending) return; if (password !== confirmation) { setError('Passwords do not match.'); return; } setPending(true); setError(null); try { if (await api.reset(token, password)) { setPassword(''); setConfirmation(''); setDone(true); } else setError('This reset link is invalid, expired, or already used.'); } catch { setError('Reset is unavailable. Please try again later.'); } finally { setPending(false); } }
  return <main className="grid min-h-dvh place-items-center bg-background p-4" aria-labelledby="reset-title">
    <Card className="w-full max-w-md"><CardHeader><h1 id="reset-title" className="text-2xl font-semibold tracking-tight">Reset your password</h1></CardHeader><CardContent>
      {done ? <p>Password updated. All previous sessions and pending send approvals were revoked. Sign in again.</p> : token && <form onSubmit={event => { void submit(event); }}><FieldSet disabled={pending}>
        <Field><FieldLabel htmlFor="reset-password">New password</FieldLabel><Input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={event => { setPassword(event.target.value); }} /></Field>
        <Field><FieldLabel htmlFor="reset-confirmation">Confirm new password</FieldLabel><Input id="reset-confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={event => { setConfirmation(event.target.value); }} /></Field>
        <Button type="submit" disabled={pending}>{pending ? <><Spinner />Updating…</> : 'Update password'}</Button>
      </FieldSet></form>}
      {error && <p role="alert">{error}</p>}
      <Button type="button" variant="ghost" onClick={onLogin}>Back to login</Button>
    </CardContent></Card>
  </main>;
}
