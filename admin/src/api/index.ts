/**
 * The admin's data module. Pages and components import from "@/api" only, never from the
 * files inside this folder, and never from ./mock.
 *
 *   endpoints.ts   every call, with the HTTP request it stands for (the contract for W2)
 *   types.ts       the typed objects those calls take and return (section 4 field names)
 *   errors.ts      ApiError, the one error every failed call rejects with
 *   transport.ts   turns a call into a request; phase A0 sends it to ./mock, W2 to fetch()
 *   mock/          in-memory stand-in for the API; deleted in W2
 */

export * from './endpoints'
export * from './errors'
export * from './types'
