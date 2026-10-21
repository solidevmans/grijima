# 설계 개요

## 한 줄
요구사항정의서(엑셀/텍스트)를 넣으면 유스케이스 초안을 만들고, 화면에서 다듬은 뒤
Enterprise Architect(EA)에 임포트할 XMI를 내보내는 **Electron 데스크톱 앱**. 이름: 그리지마 / EA UseCase Studio.

## 흐름
요구사항 정의서 → [가져오기] → 로컬 LLM → 정규화 → [편집] → [검증] → [내보내기] → EA (XMI 1.1)
LLM은 "가져오기"까지만 쓴다. 그 뒤는 전부 사람이 트리·폼·캔버스에서 고친다.

## 제약
- **폐쇄망**: 외부 통신 없음. LLM은 앱에 내장된 gguf 모델(node-llama-cpp). 인터넷 API 금지.
- **재임포트**: 같은 프로젝트를 EA에 다시 임포트하면 기존 요소가 갱신돼야 한다 (GUID 유지).
- **요구사항 1건 = EA 패키지(UCD) 1개** 가 모델의 축.

## 기술
Electron + electron-vite, React 18, zustand, TypeScript, exceljs, node-llama-cpp.
src/main/core 가 파이프라인 본체(excel → extract → generate → normalize → validate → xmi).
src/renderer 가 화면(ImportView / TreeView / DiagramView / ExportView / SettingsView).

## 현재 상태 (2026-10)
약 80% 완성. 해커톤 시연 흐름은 동작함. 남은 것은 **실사업 정의서로 파일럿 검증**과 **UI 단순화**.

## 고도화 목표 (우선순위 순)
1. 실제 정의서를 넣었을 때 손보지 않고 EA에 넣을 수 있는 품질
2. UI는 직관적이어야 한다. 가져오기·수정·내보내기가 설명 없이 되어야 한다. 수정 흐름이 복잡해지면 실패다.
3. 작은 모델(3b)에서도 결과가 흔들리지 않게

## 저장 구조 (2026-10 결정)
**프로젝트 1개 = 폴더 1개. 원본은 사람이 읽을 수 있는 마크다운 파일.** `.eaucs` 단일 JSON은 이 구조로 대체한다.
```
<프로젝트명>/
  project.md               메타: 시스템명, projectId(GUID 시드), 작성자, 원본 정의서 경로
  actors/<액터명>.md         상단 속성(id) + 설명
  usecases/<UC코드>.md       상단 속성(id, package, actors, include, extend, reqId) + 본문(설명·흐름)
  diagrams/<UCD코드>.md      상단 속성(id, package) + 노드 좌표 (캔버스에서 옮긴 위치)
  uml/<UCD코드>.puml          PlantUML — 다이어그램마다 1개, 저장할 때 같이 갱신
  export/<프로젝트명>.xmi     마지막으로 내보낸 XMI (EA 임포트용)
  source/                   원본 요구사항정의서 사본
```
- 왜 마크다운 폴더인가: 옵시디언·메모장으로 열어 사람이 고칠 수 있고, 파일 단위라 git 변경 내역이 보이고, 폐쇄망에 설치할 게 없다. 이 앱의 성격(공공·폐쇄망·사람이 고침)에 맞는다.
- UML(puml)과 다이어그램 좌표도 프로젝트 폴더 안에 둔다. 캔버스에서 공들여 배치한 좌표가 XMI geometry가 되는데, 이게 프로젝트 밖에 있으면 프로젝트를 옮길 때 사라진다.
- **SQLite는 지금 쓰지 않는다.** 검색·검증이 느려져 문제가 되면 그때 "앱이 열 때 만드는 캐시"로만 붙인다. 원본은 어디까지나 파일이다.
- GUID는 project.md의 시드 + 요소 id로 결정되게 유지한다. 재임포트 때 갱신이 되는 근거이므로, 파일을 옮겨도 GUID가 안 바뀌어야 한다.
- 기존 `.eaucs` 파일은 "열기"로 읽어 폴더로 변환할 수 있어야 한다 (한 번에 이전).
