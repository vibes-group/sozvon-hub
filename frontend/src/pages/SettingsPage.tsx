import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { fetchMe, type User } from '../api';
import { AdminUsersCard, InvitesCard, ProfileCard } from './accountCards';

export default function SettingsPage() {
  const [me, setMe] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <main className="min-h-dvh grid place-items-center bg-bg-0 text-muted-2">
        <span className="text-[13px] uppercase tracking-[0.14em]">Загрузка…</span>
      </main>
    );
  }

  if (!me) return <Navigate to="/" replace />;

  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg-0 text-body px-4 py-10">
      <div className="w-full max-w-md grid gap-4">
        <header className="flex items-center justify-between gap-3 px-1">
          <Link to="/" className="btn btn-secondary btn-mini">
            <ArrowLeft size={15} /> Назад
          </Link>
          <h1 className="text-[13px] uppercase tracking-[0.14em] text-muted-2">Настройки</h1>
        </header>

        <ProfileCard user={me} onUpdated={setMe} />
        {(me.canInvite || me.isAdmin) && <InvitesCard isAdmin={me.isAdmin} />}
        {me.isAdmin && <AdminUsersCard />}
      </div>
    </main>
  );
}
