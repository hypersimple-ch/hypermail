import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { AppPage, PageContainer, PageHeader } from '@/components/app/patterns.js';
import { toast } from '@/components/heroui/toast.js';
import { Button } from '@/components/heroui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/heroui/card.js';
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet } from '@/components/heroui/field.js';
import { Input } from '@/components/heroui/input.js';
import { Spinner } from '@/components/heroui/spinner.js';

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

export interface AccountProps {
  ownerEmail: string;
  onChangePassword: (input: ChangePasswordInput) => Promise<ChangePasswordResult>;
  onSignOut: () => Promise<void>;
  onBack: () => void;
}

const minimumPasswordLength = 12;

export function Account({ ownerEmail, onChangePassword, onSignOut, onBack }: AccountProps): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [passwordPending, setPasswordPending] = React.useState(false);
  const [signOutPending, setSignOutPending] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState('');
  const pending = passwordPending || signOutPending;

  const changePassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (!currentPassword) {
      setPasswordError('Enter your current password.');
      return;
    }
    if (newPassword.length < minimumPasswordLength) {
      setPasswordError('Your new password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmation) {
      setPasswordError('New password and confirmation must match.');
      return;
    }
    setPasswordError('');
    setPasswordPending(true);
    void onChangePassword({ currentPassword, newPassword }).then((result) => {
      if (!result.ok) {
        toast.danger(result.error);
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      toast.success('Password changed.');
    }).catch(() => {
      toast.danger('Could not change your password. Try again.');
    }).finally(() => {
      setPasswordPending(false);
    });
  };

  const signOut = () => {
    if (pending) return;
    setPasswordError('');
    setSignOutPending(true);
    void onSignOut().then(() => {
      toast.success('Signed out.');
    }).catch(() => {
      toast.danger('Could not sign out. Try again.');
    }).finally(() => {
      setSignOutPending(false);
    });
  };

  return <AppPage aria-label="Account"><PageContainer measure="form">
    <PageHeader title="Account" description="Private owner settings" actions={<Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={pending}><ArrowLeft aria-hidden="true" />More</Button>} />
    <div className="mt-6 space-y-4">
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 pt-4 pb-0"><CardTitle>Owner identity</CardTitle><CardDescription>This email identifies the private owner account.</CardDescription></CardHeader>
        <CardContent className="px-4 pt-4 pb-4"><Field><FieldLabel htmlFor="account-owner-email">Email</FieldLabel><Input id="account-owner-email" type="email" value={ownerEmail} readOnly autoComplete="email" /></Field></CardContent>
      </Card>
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 pt-4 pb-0"><CardTitle>Password</CardTitle><CardDescription>Confirm your current password before choosing a new one.</CardDescription></CardHeader>
        <CardContent className="px-4 pt-4 pb-4">
          <form onSubmit={changePassword} noValidate>
            <FieldSet disabled={pending}>
              <Field><FieldLabel htmlFor="account-current-password">Current password</FieldLabel><Input id="account-current-password" name="currentPassword" type="password" autoComplete="current-password" disabled={pending} value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); }} required /></Field>
              <Field><FieldLabel htmlFor="account-new-password">New password</FieldLabel><Input id="account-new-password" name="newPassword" type="password" autoComplete="new-password" disabled={pending} minLength={minimumPasswordLength} maxLength={1024} value={newPassword} onChange={(event) => { setNewPassword(event.target.value); }} required aria-describedby="account-password-help" /><FieldDescription id="account-password-help">Use at least 12 characters.</FieldDescription></Field>
              <Field><FieldLabel htmlFor="account-confirm-password">Confirm new password</FieldLabel><Input id="account-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" disabled={pending} minLength={minimumPasswordLength} maxLength={1024} value={confirmation} onChange={(event) => { setConfirmation(event.target.value); }} required aria-invalid={passwordError ? 'true' : undefined} aria-describedby={passwordError ? 'account-password-help account-password-error' : 'account-password-help'} /></Field>
              {passwordError ? <FieldError id="account-password-error">{passwordError}</FieldError> : null}
              <Button type="submit" disabled={pending}>{passwordPending ? <><Spinner />Changing password…</> : 'Change password'}</Button>
            </FieldSet>
          </form>
        </CardContent>
      </Card>
      <Card className="gap-0 py-0">
        <CardHeader className="px-4 pt-4 pb-0"><CardTitle>Sign out</CardTitle><CardDescription>End this session on this device.</CardDescription></CardHeader>
        <CardContent className="px-4 pt-4 pb-4"><Button type="button" variant="outline" onClick={signOut} disabled={pending}>{signOutPending ? <><Spinner />Signing out…</> : 'Sign out'}</Button></CardContent>
      </Card>
    </div>
  </PageContainer></AppPage>;
}
