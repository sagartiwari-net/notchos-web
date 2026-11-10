import { FileQuestionIcon } from 'lucide-react'
import { Link } from 'react-router'

import { EmptyState } from '@/components/data-states'
import { Button } from '@/components/ui/button'
import { usePageTitle } from '@/hooks/use-page-title'

/** Any address inside the admin that is not a page, including the pages that arrive in W3. */
export function NotFoundPage() {
  usePageTitle('Page not found')
  return (
    <EmptyState
      icon={FileQuestionIcon}
      title="There is no page at this address"
      description="Check the address, or pick a page from the sidebar. Payments, Webhooks and Emails are not built yet; they arrive in phase W3."
    >
      <Button variant="outline" asChild>
        <Link to="/">Go to the dashboard</Link>
      </Button>
    </EmptyState>
  )
}
