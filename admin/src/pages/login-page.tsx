import { useEffect, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { FlaskConicalIcon, TriangleAlertIcon } from 'lucide-react'
import { Navigate, useSearchParams } from 'react-router'

import { dataSource, errorMessage, isApiError, login, type Session } from '@/api'
import { FullPageSpinner } from '@/components/data-states'
import { NotchMark } from '@/components/notch-mark'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Spinner } from '@/components/ui/spinner'
import { safeNextPath } from '@/frame/nav'
import { usePageTitle } from '@/hooks/use-page-title'
import { clearCachedData, queryClient, queryKeys, useSession } from '@/lib/query'

const CODE_LENGTH = 6
const CODE_SLOTS = Array.from({ length: CODE_LENGTH }, (_, index) => index)

/** Why signing in failed. After too many tries it also says how long to wait, if the server did. */
function signInProblem(error: unknown): string {
  if (isApiError(error) && error.code === 'rate_limited' && error.retryAfterSeconds !== undefined) {
    const minutes = Math.max(1, Math.ceil(error.retryAfterSeconds / 60))
    return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
  }
  return errorMessage(error)
}

export function LoginPage() {
  usePageTitle('Sign in')
  const [searchParams] = useSearchParams()
  const next = safeNextPath(searchParams.get('next'))
  const session = useSession()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  // Field messages appear after the first attempt, not while the admin is still typing.
  const [attempted, setAttempted] = useState(false)

  const signIn = useMutation({
    mutationFn: login,
    onSuccess: (signedIn) => {
      // The <Navigate> below then takes the admin to the page they asked for.
      queryClient.setQueryData<Session | null>(queryKeys.session, signedIn)
    },
    onError: () => {
      // An authenticator code is good for one try. The emptied field is not a mistake of the
      // admin, so the field messages wait for the next attempt.
      setCode('')
      setAttempted(false)
    },
  })

  // Whatever was loaded for an earlier session is not shown to the next one.
  useEffect(() => {
    clearCachedData()
  }, [])

  if (session.isPending) {
    return <FullPageSpinner label="Checking your session" />
  }
  if (session.data) {
    return <Navigate to={next} replace />
  }

  const problems = {
    username: username.trim() === '' ? 'Enter your username.' : undefined,
    password: password === '' ? 'Enter your password.' : undefined,
    code: new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code) ? undefined : `Enter the ${CODE_LENGTH}-digit code.`,
  }
  const shown = attempted ? problems : { username: undefined, password: undefined, code: undefined }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (problems.username !== undefined || problems.password !== undefined || problems.code !== undefined) {
      return
    }
    signIn.mutate({ username: username.trim(), password, code })
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-xs flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md border bg-card">
            <NotchMark />
          </span>
          <div className="grid leading-tight">
            <span className="text-sm font-medium">NotchOS</span>
            <span className="text-xs text-muted-foreground">Admin</span>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              <h1>Sign in</h1>
            </CardTitle>
            <CardDescription>Username, password and the code from your authenticator app.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate>
              <FieldGroup>
                <Field data-invalid={shown.username !== undefined}>
                  <FieldLabel htmlFor="login-username">Username</FieldLabel>
                  <Input
                    id="login-username"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    aria-invalid={shown.username !== undefined}
                  />
                  {shown.username !== undefined && <FieldError>{shown.username}</FieldError>}
                </Field>

                <Field data-invalid={shown.password !== undefined}>
                  <FieldLabel htmlFor="login-password">Password</FieldLabel>
                  <Input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={shown.password !== undefined}
                  />
                  {shown.password !== undefined && <FieldError>{shown.password}</FieldError>}
                </Field>

                <Field data-invalid={shown.code !== undefined}>
                  <FieldLabel htmlFor="login-code">Authenticator code</FieldLabel>
                  <InputOTP
                    id="login-code"
                    name="code"
                    maxLength={CODE_LENGTH}
                    pattern={REGEXP_ONLY_DIGITS}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={setCode}
                    aria-invalid={shown.code !== undefined}
                  >
                    <InputOTPGroup>
                      {CODE_SLOTS.map((index) => (
                        <InputOTPSlot key={index} index={index} aria-invalid={shown.code !== undefined} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                  {shown.code !== undefined ? (
                    <FieldError>{shown.code}</FieldError>
                  ) : (
                    <FieldDescription>The 6 digits your authenticator app shows right now.</FieldDescription>
                  )}
                </Field>

                {signIn.isError && (
                  <Alert variant="destructive" data-testid="login-error">
                    <TriangleAlertIcon />
                    <AlertTitle>Could not sign in</AlertTitle>
                    <AlertDescription>{signInProblem(signIn.error)}</AlertDescription>
                  </Alert>
                )}

                <Button type="submit" disabled={signIn.isPending}>
                  {signIn.isPending && <Spinner data-icon="inline-start" />}
                  Sign in
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        {dataSource === 'mock' && (
          <Alert data-testid="mock-notice">
            <FlaskConicalIcon />
            <AlertTitle>Running on mock data</AlertTitle>
            <AlertDescription>
              No server is connected. Any username and password with any 6 digits will sign you in, and everything
              you see afterwards is made-up sample data.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  )
}
