import { describe, expect, it } from 'vitest';
import { enrollDevice, newDeviceId, unlockDevicePrivateKey } from '../device.js';
import { ready } from '../sodium.js';

await ready();

describe('device enrollment', () => {
  it('enrolls a device and lets the right password unlock the private key', async () => {
    const r = await enrollDevice({
      password: 'a-long-enough-test-password',
      deviceId: newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    expect(r.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    const secretKey = await unlockDevicePrivateKey(r, 'a-long-enough-test-password');
    expect(secretKey).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('wrong password fails to unlock', async () => {
    const r = await enrollDevice({
      password: 'a-long-enough-test-password',
      deviceId: newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    await expect(unlockDevicePrivateKey(r, 'nope')).rejects.toThrow();
  });

  it('produces distinct device ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newDeviceId());
    expect(ids.size).toBe(200);
  });
});
