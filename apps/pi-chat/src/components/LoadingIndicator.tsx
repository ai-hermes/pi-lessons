import { useEffect, useState } from "react";

const chevronDelays = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function useElapsed() {
  const [tenths, setTenths] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setTenths((value) => value + 1),
      100,
    );
    return () => window.clearInterval(timer);
  }, []);

  const seconds = tenths / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

export function LoadingIndicator() {
  const elapsed = useElapsed();

  return (
    <div className="message-loading" role="status" aria-label="正在生成回复">
      <span className="loading-grid" aria-hidden>
        {chevronDelays.map((delay, index) => (
          <span
            key={index}
            className="loading-pixel"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="loading-label">正在生成</span>
      <span className="loading-elapsed">{elapsed}</span>
    </div>
  );
}
