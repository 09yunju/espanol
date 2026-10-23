# 문제은행

GitHub Pages에서 동작하는 개인용 문제은행 웹앱입니다. 문제와 풀이 기록은 비공개 GitHub 저장소의 JSON 파일에만 저장되고, 기기에는 토큰 외에 아무것도 남지 않습니다.

```
앱 저장소 (public)   index.html, app.js, style.css, manifest, 아이콘 → GitHub Pages
데이터 저장소 (private) problems.json, stats.json, words.json → 앱이 Contents API로 읽고 커밋
```

## 설치

1. **앱 저장소**: public 저장소(예: `qbank`)를 만들고 이 폴더의 파일을 모두 루트에 올립니다.
   Settings › Pages › Build and deployment에서 Source를 *Deploy from a branch*, 브랜치를 `main` / `(root)`로 지정합니다.
   잠시 후 `https://<아이디>.github.io/qbank/`에서 열립니다.
2. **데이터 저장소**: private 저장소(예: `qbank-data`)를 만듭니다. *Add a README file*을 체크해서 빈 저장소가 되지 않게 해 주세요. JSON 파일은 앱이 첫 저장 때 만듭니다.
3. **토큰**: Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token
   - Repository access: *Only select repositories* → 데이터 저장소만 선택
   - Repository permissions: **Contents → Read and write** (Metadata 읽기 권한은 자동으로 포함)
   - Expiration: 원하는 기간. 만료되면 앱에 새 토큰을 입력하면 됩니다.
4. 앱을 열고 데이터 저장소(`아이디/qbank-data`)와 토큰을 입력합니다.
5. **휴대폰**: 같은 주소를 열고 홈 화면에 추가합니다(iOS Safari는 공유 › 홈 화면에 추가, Android Chrome은 메뉴 › 홈 화면에 추가). 토큰은 기기마다 한 번씩 입력해야 합니다.

## 데이터 형식

`problems.json`은 직접 편집하거나 다른 곳에서 만든 문제를 붙여 넣어도 됩니다. **파일 순서가 곧 문제 번호**입니다.

```json
{
  "version": 2,
  "problems": [
    {
      "id": "p01",
      "question": "밑줄 친 부분과 의미가 같은 것은?\nElla __habla__ español muy bien.",
      "choices": ["**come**", "dice", "corre", "duerme"],
      "answer": 2,
      "explanation": "hablar = 말하다, decir = 말하다"
    }
  ]
}
```

| 필드 | 설명 |
|---|---|
| `answer` | 정답 보기 번호(**1부터**) |
| `question`, `choices`, `explanation` | `**굵게**`, `__밑줄__` 사용 가능. 한 줄 안에서만 적용되고, 겹쳐 쓸 수도 있습니다(`**__굵은 밑줄__**`) |
| `id` | 생략하면 앱이 다음 저장 때 채워 넣습니다. 중복만 피하면 됩니다 |
| `createdAt`, `updatedAt` | 앱이 기록하며, 생략해도 됩니다 |

보기가 2개 미만인 문제는 목록에 "보기가 부족해요"로 표시되고 풀기에서 제외됩니다.

`stats.json`(문제별 풀이 횟수, 정답 수, 최근 결과)은 앱이 관리하므로 직접 수정할 필요가 없습니다.

## 단어장

단어 탭에서 단어와 뜻을 등록하고, 단어를 누르면 카드로 공부할 수 있습니다. 카드를 누르면 뒤집혀 뜻이 보이고, 이전/다음 버튼이나 좌우로 밀어서 넘깁니다(PC에서는 ←/→, Space).

`words.json` 형식:

```json
{
  "version": 1,
  "words": [
    { "id": "w01", "word": "hablar", "meaning": "말하다" },
    { "id": "w02", "word": "¿dónde?", "meaning": "어디\n(의문사)" }
  ]
}
```

`id`는 생략해도 됩니다. 뜻에는 줄바꿈(`\n`)을 넣을 수 있습니다.

**발음**은 브라우저 내장 음성 합성(Web Speech API)을 쓰며, 기기에 설치된 스페인어 음성(es-ES 우선, 없으면 다른 스페인어권 음성)으로 읽습니다. 외부 서버로 요청을 보내지 않습니다. 소리가 나지 않으면 다음을 확인하세요.

- 기기에 스페인어 음성이 있는지: iOS는 설정 › 손쉬운 사용 › 읽기 및 말하기 › 음성, Android는 Google 텍스트 음성 변환 설정에서 스페인어 음성 데이터를 설치합니다.
- iPhone의 무음 모드: 무음 모드에서는 소리가 나지 않을 수 있습니다.

## 동작 방식

- **저장**: 문제를 저장, 수정, 삭제할 때마다 `problems.json`에 커밋이 하나씩 생깁니다. 커밋이 끝나야 저장이 완료되고, 실패하면 편집 창에 오류가 표시됩니다.
- **동시 수정**: 다른 기기에서 먼저 커밋해 sha가 어긋나면(409) 최신 파일을 다시 받아 변경을 적용한 뒤 재시도합니다.
- **풀이 기록**: 답할 때마다 커밋하지 않고 메모리에 모았다가 5문제마다, 결과 화면에서, 또는 앱이 백그라운드로 갈 때 한 번에 커밋합니다. 앱이 강제 종료되면 마지막 몇 문제의 기록은 빠질 수 있습니다.
- **새로고침**: 앱을 다시 열거나 1분 이상 지나 화면으로 돌아오면 GitHub에서 최신 데이터를 받아옵니다.

## 보안 메모

- 토큰은 `localStorage`에 평문으로 저장됩니다. 설정에서 *이 기기에 토큰 기억하기*를 끄면 `sessionStorage`에만 두어 앱을 닫을 때 지워집니다.
- CSP로 스크립트는 같은 출처의 `app.js`만, 네트워크 연결은 `api.github.com`만 허용합니다. 외부 스크립트는 쓰지 않습니다(Google Fonts 스타일시트만 사용).
- **주의**: `<아이디>.github.io` 아래의 모든 Pages 사이트는 같은 출처(origin)라서 `localStorage`를 공유합니다. 같은 계정으로 다른 Pages 사이트를 운영한다면, 그 사이트의 스크립트도 토큰을 읽을 수 있습니다. 이 앱만 별도 출처에 두려면 커스텀 도메인을 연결하거나, 이 앱 전용 GitHub 조직(`<조직>.github.io`)에서 Pages를 운영하세요.
- 토큰 권한은 데이터 저장소의 Contents로만 제한하세요. 유출되더라도 그 저장소 밖에는 영향이 없습니다.
