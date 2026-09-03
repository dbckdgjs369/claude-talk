// 방 사이 말 전달의 조율.
//
// main.js에서 떼어낸 이유는 홉 상한이 electron 없이 검증돼야 해서다. 여기가 틀리면
// 두 방이 사람 없이 무한히 주고받으며 토큰을 태우는데, 그건 실행 중에 눈으로 잡기 어렵다.
const { planRelays } = require('./mentions');

// deps:
//   handleIndex()                              → Map<호출명, room>
//   deliver(targetRoom, fromHandle, body, hops) → 상대 방에 실제로 넣기
//   sysMessage(session, text)                   → 보낸 방에 회색 안내 한 줄
function createRelay({ maxHops = 6, handleIndex, deliver, sysMessage }) {
  return function handleRelays(fromRoom, s, text) {
    // 압축 요약에 섞인 @는 누가 한 말이 아니다. 호출명이 없는 방은 발신자를 밝힐 수 없다.
    if (s._autoCompacting || !fromRoom.handle) return;

    const idx = handleIndex();
    const { hops, sends, blocked } = planRelays(text, [...idx.keys()], {
      fromHandle: fromRoom.handle,
      priorHops: s._relayHops || 0,
      maxHops,
    });
    if (!sends.length && !blocked.length) return;

    // 홉은 세션이 아니라 "체인"의 것이다. 보낸 쪽도 같이 올려야 한다 —
    // 받는 쪽만 올리면, 상한에 막힌 뒤에도 낡은 값을 든 쪽이 계속 보내고 상대는 계속
    // 막기만 하는 상태로 영원히 턴을 돌린다 (상한이 있어도 없는 것과 같아진다).
    s._relayHops = hops;

    for (const handle of blocked) {
      sysMessage(
        s,
        `🔁 전달이 ${maxHops}번 오갔어요. @${handle} 에게는 보내지 않았습니다 — ` +
          `계속하려면 직접 말을 걸어주세요.`
      );
    }
    for (const r of sends) {
      const target = idx.get(r.handle);
      if (!target) continue;
      deliver(target, fromRoom.handle, r.body, hops);
      sysMessage(s, `↗ @${r.handle} 에게 전달했어요`);
    }
  };
}

module.exports = { createRelay };
