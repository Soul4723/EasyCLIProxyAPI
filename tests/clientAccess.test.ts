import { describe, expect, it } from 'bun:test';
import { clientApiProfiles, webUiManagementUrl } from '../src/services/clientAccess';

describe('客户端 API 接入信息', () => {
  it('生成 OpenAI、Claude 和 Gemini 三种正确格式', () => {
    const profiles = clientApiProfiles(9527);

    expect(profiles.map((profile) => profile.id)).toEqual(['openai', 'claude', 'gemini']);
    expect(profiles[0].baseUrl).toBe('http://127.0.0.1:9527/v1');
    expect(profiles[1].baseUrl).toBe('http://127.0.0.1:9527');
    expect(profiles[2].baseUrl).toBe('http://127.0.0.1:9527');
  });

  it('端口无效时回退到 8317，缺少局域网地址时保持为空', () => {
    const [openai] = clientApiProfiles(0);

    expect(openai.baseUrl).toBe('http://127.0.0.1:8317/v1');
  });

  it('TLS 开启时生成 HTTPS 客户端地址', () => {
    const profiles = clientApiProfiles(9527, true);

    expect(profiles[0].baseUrl).toBe('https://127.0.0.1:9527/v1');
    expect(profiles[1].baseUrl).toBe('https://127.0.0.1:9527');
  });

  it('使用当前内核端口生成 WebUI 登录地址', () => {
    expect(webUiManagementUrl(9527)).toBe(
      'http://127.0.0.1:9527/management.html#/login',
    );
    expect(webUiManagementUrl(0)).toBe(
      'http://127.0.0.1:8317/management.html#/login',
    );
    expect(webUiManagementUrl(9527, true)).toBe(
      'https://127.0.0.1:9527/management.html#/login',
    );
  });

  it('uses the configured listen IP for API and WebUI URLs', () => {
    const [openai] = clientApiProfiles(9527, true, '192.168.1.20');

    expect(openai.baseUrl).toBe('https://192.168.1.20:9527/v1');
    expect(webUiManagementUrl(9527, true, '192.168.1.20')).toBe(
      'https://192.168.1.20:9527/management.html#/login',
    );
  });

  it('converts wildcard and IPv6 listen IPs to connectable URL hosts', () => {
    expect(webUiManagementUrl(8317, false, '0.0.0.0')).toBe(
      'http://127.0.0.1:8317/management.html#/login',
    );
    expect(webUiManagementUrl(8317, false, '::')).toBe(
      'http://[::1]:8317/management.html#/login',
    );
    expect(clientApiProfiles(8317, false, '2001:db8::1')[0].baseUrl).toBe(
      'http://[2001:db8::1]:8317/v1',
    );
  });
});


describe('remote client API target', () => {
  const remote = { mode: 'remote' as const, remoteManagementOrigin: 'https://management.example', remoteManagementKey: 'management-secret', clientApiOrigin: 'http://100.64.0.2:8317', clientApiKey: 'client-secret' };
  it('uses explicit HTTP / HTTPS / IPv6 client origins, independently of local settings and management origin', () => {
    for (const origin of ['http://100.64.0.2:8317', 'https://clients.example', 'https://[2001:db8::2]:8443']) {
      const profiles = clientApiProfiles(9000, false, 'localhost', { ...remote, clientApiOrigin: origin });
      expect(profiles.map(p => p.baseUrl)).toEqual([`${origin}/v1`, origin, origin]);
    }
  });
  it('offers no loopback or management fallback for management-only attachments', () => {
    expect(clientApiProfiles(9000, false, 'localhost', { ...remote, clientApiOrigin: '', clientApiKey: '' })).toEqual([]);
    expect(() => clientApiProfiles(9000, false, 'localhost', { ...remote, clientApiOrigin: 'https://clients.example/v1' })).toThrow();
  });
  it('keeps local targets when remote settings were saved previously', () => {
    expect(clientApiProfiles(9000, false, 'localhost', { ...remote, mode: 'local' })[0].baseUrl).toBe('http://localhost:9000/v1');
  });
});
