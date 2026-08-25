import { useState } from 'react';
import { toast } from 'sonner';
import { signIn, signUp } from '@/lib/auth';
import { Wordmark } from '@/components/Mark';
import { Button, Card, CardContent, Field, Input } from '@/components/ui';

export function SignIn({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    setNotice(null);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        onAuthed();
      } else {
        const session = await signUp(email, password);
        // Signing up fires a Postgres trigger that provisions the org
        // and an owner membership, so there is nothing else to set up.
        if (session) onAuthed();
        else setNotice('Account created. Check your email to confirm, then sign in.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <Wordmark className="mb-6 text-lg" />

          {/* A real form element, so password managers and Enter-to-submit
              both behave the way people expect. */}
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email" htmlFor="email">
              <Input
                id="email" type="email" autoComplete="username" required
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password" type="password" required
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          {notice && <p className="mt-3 text-center text-xs text-muted">{notice}</p>}

          <button
            type="button"
            className="mt-4 w-full text-center text-xs text-accent-ink hover:underline cursor-pointer"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setNotice(null); }}
          >
            {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
