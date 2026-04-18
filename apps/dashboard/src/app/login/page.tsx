import { LoginForm } from './form';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-bold text-amber-500">
            ScrapeForge
          </h1>
          <p className="mt-1 text-sm text-charcoal-500">Sign in to your dashboard</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
