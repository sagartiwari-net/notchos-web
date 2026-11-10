import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react'
import { useRouteError } from 'react-router'

import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

/** Shown instead of a blank screen when a page throws while rendering. */
export function RouteError() {
  const error = useRouteError()
  // Useful when it happens during development; the screen itself stays plain.
  console.error(error)

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>This page stopped working</EmptyTitle>
          <EmptyDescription>
            Something in the admin panel itself went wrong. Reload the page. If it happens again, note what you
            clicked just before.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RotateCcwIcon data-icon="inline-start" />
            Reload
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
