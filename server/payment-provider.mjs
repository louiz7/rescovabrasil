import { assert } from './domain.mjs';

// Provider boundary: network adapters implement these async commands, returning normalized
// snapshots. Stable request.id is the provider idempotency key on every retry.
export function createSimulatorPaymentProvider() {
  return {
    name: 'simulator',
    mode: 'simulation',
    async createRequest(request) {
      return {
        providerRequestId: request.id,
        url: `https://payments.example.invalid/request/${request.id}`,
      };
    },
    async retrievePayment() {
      throw new Error('Simulator events are supplied explicitly; no external account exists.');
    },
    async verifyAndNormalizeWebhook() {
      throw new Error(
        'The simulator has no public webhook. Use the authenticated simulation command.',
      );
    },
  };
}
export function validatePaymentProvider(adapter) {
  assert(
    adapter &&
      typeof adapter.name === 'string' &&
      ['simulation', 'sandbox', 'live'].includes(adapter.mode),
    'Invalid payment provider.',
  );
  for (const method of ['createRequest', 'retrievePayment', 'verifyAndNormalizeWebhook'])
    assert(typeof adapter[method] === 'function', `Payment adapter requires ${method}.`);
  return adapter;
}
