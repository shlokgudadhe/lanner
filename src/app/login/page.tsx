'use client'

import { createClient } from '@/utils/supabase/client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const checkUser = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        router.push('/planner')
      }
    }
    checkUser()
  }, [router, supabase])

  const handleGoogleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`
      }
    })
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 bg-[oklch(0.14_0.006_90)] text-[oklch(0.92_0.004_90)] font-sans">
      <div className="max-w-md w-full flex flex-col items-center gap-8 bg-[oklch(0.18_0.006_90)] border border-[oklch(0.28_0.006_90)] rounded-3xl p-8 sm:p-10 shadow-2xl">
        <div className="hatch w-16 h-16 rounded-2xl border border-[oklch(0.32_0.006_90)] flex items-center justify-center shadow-lg">
          <span className="text-[#d9a441] font-mono text-2xl font-bold">D</span>
        </div>
        
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-[oklch(0.94_0.004_90)]">LockIn</h1>
          <p className="text-[oklch(0.62_0.006_90)] text-sm leading-relaxed max-w-xs">
            Sign in to start mapping your day with intentional, time-blocked clarity.
          </p>
        </div>

        <button
          onClick={handleGoogleLogin}
          className="w-full flex items-center justify-center gap-3 bg-[oklch(0.22_0.006_90)] text-[oklch(0.92_0.004_90)] border border-[oklch(0.34_0.006_90)] py-3.5 px-5 rounded-xl shadow-md hover:bg-[oklch(0.26_0.006_90)] hover:border-[#d9a441]/50 transition-all font-medium text-sm cursor-pointer"
        >
          <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </button>
      </div>
    </div>
  )
}

