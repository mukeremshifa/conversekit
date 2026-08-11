import { useState } from 'react';
import { toast } from 'sonner';
import { Zap } from 'lucide-react';
import { endpoints } from '@/lib/api';
import { Button, Card, CardContent, CardDescription, Field, Input } from '@/components/ui';

/**
 * Shown when an account has no organization. Normally unreachable —
 * signup provisions one via a trigger — but that trigger fires only on
 * INSERT, so an account that loses its last org has no other way back.
 */
export function NoOrg({
  email, onCreated, onSignOut,
}: { email: string | null; onCreated: () => void; onSignOut: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await endpoints.createOrg(name.trim());
      toast.success('Workspace created');
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create workspace');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <div className="mb-4 flex items-center gap-2">
            <Zap className="h-5 w-5 text-accent" />
            <span className="text-lg font-bold tracking-tight">ConverseKit</span>
          </div>
          <CardDescription className="mb-5">
            {email} has no workspace yet. Create one to start building bots.
          </CardDescription>

          <form onSubmit={submit} className="space-y-4">
            <Field label="Workspace name" htmlFor="org">
              <Input
                id="org" required autoFocus
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Acme Agency"
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Creating…' : 'Create workspace'}
            </Button>
          </form>

          <button
            type="button"
            className="mt-4 w-full text-center text-xs text-muted hover:underline cursor-pointer"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
