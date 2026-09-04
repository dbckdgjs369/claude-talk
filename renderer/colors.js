// 방 색상 팔레트. 목록 창과 방 창이 같은 색을 써야 하므로 한 곳에 둔다
// (렌더러도 nodeIntegration이 켜져 있어서 require가 된다).
//
// 파스텔로 고른 이유는 다크·라이트 양쪽에 같은 값을 쓰기 위해서다. 채도가 높으면 라이트에서
// 눈이 아프고, 너무 옅으면 다크에서 회색으로 뭉개진다. 중간 밝기 파스텔이 양쪽에서 견딘다.
//
// 아바타 배경으로도 쓰이는데 그 위에 얹히는 클로드 캐릭터가 주황(#d97757)이다. 그래서
// 주황 계열은 1번 살구 하나만 두고 나머지는 색상환에서 떨어뜨렸다 — 안 그러면 캐릭터가
// 배경에 묻힌다.
const ROOM_COLORS = [
  { id: 1, name: '살구', hex: '#f0a58c' },
  { id: 2, name: '노랑', hex: '#eecb7a' },
  { id: 3, name: '연두', hex: '#a9cd8c' },
  { id: 4, name: '민트', hex: '#8ccebe' },
  { id: 5, name: '하늘', hex: '#8dbde2' },
  { id: 6, name: '라벤더', hex: '#a9a3e0' },
  { id: 7, name: '분홍', hex: '#e39ec2' },
  { id: 8, name: '잿빛', hex: '#aeb3bd' },
];

// 안 고른 방은 null. 저장된 값이 팔레트 밖이면(팔레트를 줄인 뒤 등) 색 없음으로 떨어진다.
function colorOf(id) {
  return ROOM_COLORS.find((c) => c.id === id) || null;
}

module.exports = { ROOM_COLORS, colorOf };
