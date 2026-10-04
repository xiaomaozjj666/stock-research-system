/**
 * 访问令牌解锁条。
 * ----------------------------------------------------------------------------
 * 为什么需要：服务端启用 `API_AUTH_TOKEN` 后会校验令牌，而浏览器默认不带任何凭据，
 * 于是页面上所有请求都会 401。这个组件是用户**唯一**的自救入口——没有它，
 * 「开启鉴权」这个动作等于把用户锁在自己的系统外面。
 *
 * 为什么默认隐藏、而不是启动就弹窗：绝大多数用户根本没配 `API_AUTH_TOKEN`
 * （本系统默认不鉴权，见 server/src/middleware.ts）。若无条件渲染弹窗，
 * 每个本地用户都要多点一次才能用。改为**探测到 401 才出现**，
 * 未启用鉴权的用户完全看不到它，行为与加这个组件之前逐字相同。
 */
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { clearApiToken, getApiToken, setApiToken } from '../api/auth';

interface ApiTokenBarProps {
  /** 是否需要展示解锁条（通常由上层捕获到 401 后置 true） */
  visible: boolean;
  /** 关闭解锁条（令牌正确时用） */
  onDismiss: () => void;
}

export function ApiTokenBar({ visible, onDismiss }: ApiTokenBarProps) {
  const [value, setValue] = useState(() => getApiToken() ?? '');
  const [revealed, setRevealed] = useState(false);

  const submit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const token = value.trim();
      if (!token) return;
      setApiToken(token);
      // 整页重载而非局部重试：解锁后需要让所有**已失败**的请求重新发起，
      // 而这些请求散落在各页面的 useEffect 里，逐个重试无法覆盖。
      window.location.reload();
    },
    [value],
  );

  const forget = useCallback(() => {
    clearApiToken();
    setValue('');
    onDismiss();
  }, [onDismiss]);

  if (!visible) return null;

  return (
    <div className="api-token-bar" role="region" aria-label="访问令牌解锁">
      <form className="api-token-bar__form" onSubmit={submit}>
        <span className="api-token-bar__label">需要访问令牌</span>
        <input
          className="api-token-bar__input"
          type={revealed ? 'text' : 'password'}
          value={value}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="粘贴 API_AUTH_TOKEN"
          aria-label="API 访问令牌"
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="api-token-bar__btn"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? '隐藏令牌' : '显示令牌'}
          title={revealed ? '隐藏令牌' : '显示令牌'}
        >
          {revealed ? '隐藏' : '显示'}
        </button>
        <button type="submit" className="api-token-bar__btn api-token-bar__btn--primary">
          解锁
        </button>
        <button type="button" className="api-token-bar__btn" onClick={forget}>
          清除
        </button>
      </form>
      <p className="api-token-bar__hint">
        后端设置了 <code>API_AUTH_TOKEN</code>。令牌与 <code>.env</code> 里的值一致， 保存在本浏览器
        localStorage；未配置该环境变量时不会出现此提示。
      </p>
    </div>
  );
}

export default ApiTokenBar;
