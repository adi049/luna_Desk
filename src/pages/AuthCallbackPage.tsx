import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/auth';
import { Spinner } from '@/components/ui';

/**
 * Landing point for Supabase magic-link / email-OTP redirects.
 * detectSessionInUrl has already exchanged the token by the time this mounts;
 * we simply wait for the profile and route on the server-verified role.
 */
export default function AuthCallbackPage() {
  const { status, profile } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (status === 'signedIn' && profile) {
      navigate(profile.role === 'admin' ? '/admin' : '/portal', { replace: true });
    } else if (status === 'signedOut') {
      navigate('/', { replace: true });
    }
  }, [status, profile, navigate]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner label="Verifying your sign-in link" />
    </div>
  );
}
