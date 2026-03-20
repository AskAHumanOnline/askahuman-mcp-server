/**
 * Integration test scaffold for the full ask_human flow.
 *
 * SKIPPED: These tests require a running AskAHuman backend and a Polar LND node
 * with funded channels. They are not intended to run in CI.
 *
 * To run locally:
 *   1. Start the AskAHuman backend (see AskAHuman documentation)
 *   2. Start Polar with at least 2 LND nodes and a funded channel
 *   3. Set environment variables (see .env.example)
 *   4. Run: INTEGRATION=true npx jest tests/integration --no-coverage
 */

describe.skip('Full flow integration tests', () => {
  // These would be initialized from environment in a real integration test run
  // const config = loadConfig();
  // const client = new AskAHumanClient(config);
  // const lightning = new LightningService(config);
  // const l402Service = new L402Service(client, lightning);
  // const credentialStore = new CredentialStore();

  test.skip('ask_human: submit -> pay -> poll -> COMPLETED', async () => {
    // 1. Call createVerificationRequest to get a 402 challenge
    //    const challenge = await client.createVerificationRequest({ ... });
    //    expect(challenge.macaroon).toBeTruthy();
    //    expect(challenge.invoice).toMatch(/^lnbc/);

    // 2. Pay the Lightning invoice via the agent's LND node
    //    const payment = await lightning.payInvoice(challenge.invoice);
    //    expect(payment.preimage).toHaveLength(64); // 32 bytes hex

    // 3. Submit the authenticated request
    //    const submission = await client.submitVerificationWithL402(req, challenge.macaroon, payment.preimage);
    //    expect(submission.status).toBe('PAYMENT_RECEIVED');

    // 4. Use the verifier dashboard to claim and complete the task
    //    (Manual step or automated via test-login + claim/submit API calls)

    // 5. Poll for result
    //    const result = await client.getVerification(challenge.verificationId);
    //    expect(result.status).toBe('COMPLETED');
    //    expect(result.result).toBeTruthy();
  });

  test.skip('ask_human: submit -> pay -> expire -> refund', async () => {
    // 1. Create and pay a verification request with short maxWaitMinutes
    //    const challenge = await client.createVerificationRequest({
    //      ..., maxWaitMinutes: 10,
    //    });
    //    const payment = await lightning.payInvoice(challenge.invoice);
    //    await client.submitVerificationWithL402(req, challenge.macaroon, payment.preimage);

    // 2. Wait for task to expire (or use test helper to force expiry)

    // 3. Verify status is EXPIRED_UNCLAIMED
    //    const status = await client.getVerification(challenge.verificationId);
    //    expect(status.status).toBe('EXPIRED_UNCLAIMED');
    //    expect(status.refundEligible).toBe(true);

    // 4. Create a refund invoice on the agent's LND node
    //    const refundInvoice = await lightning.createInvoice(status.totalInvoiceSats, 'Refund');

    // 5. Submit refund request
    //    const refundResult = await client.requestRefund(
    //      challenge.verificationId,
    //      refundInvoice.bolt11,
    //      payment.preimage,
    //    );
    //    expect(refundResult.refunded).toBe(true);
  });

  test.skip('get_pricing: returns current server pricing', async () => {
    // const pricing = await client.getPricing();
    // expect(pricing.taskTypes.length).toBeGreaterThan(0);
    // expect(pricing.urgentMultiplier).toBeGreaterThan(1);
    //
    // const binary = pricing.taskTypes.find(t => t.id === 'BINARY_DECISION');
    // expect(binary).toBeDefined();
    // expect(binary!.basePriceSats).toBeGreaterThan(0);
  });

  test.skip('check_verification: returns status for existing verification', async () => {
    // Requires a previously created verification ID
    // const status = await client.getVerification(existingVerificationId);
    // expect(status.verificationId).toBe(existingVerificationId);
    // expect(Object.values(VerificationStatus)).toContain(status.status);
  });
});
