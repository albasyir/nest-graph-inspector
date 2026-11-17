import { SetMetadata } from '@nestjs/common';

/** Metadata key AuthGuard reads to let a route through without a session. */
export const IS_PUBLIC_ROUTE = 'shop:public-route';

/**
 * Opens a route — or every route of a controller — to callers without a
 * session. Everything else is behind the global AuthGuard, so a route is
 * private unless it says otherwise.
 */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);
