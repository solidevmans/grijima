/**
 * 예시 데이터 — 가상으로 구성한 예시 요구사항(모형기술서 16건 + 액터 5명)을 옮긴 것.
 * LLM 없이도 앱 전체 흐름(트리 편집 → 다이어그램 → 검증 → XMI)을 확인할 수 있게 한다.
 */

export interface ExampleUseCase {
  name: string
  priority: 'High' | 'Medium' | 'Low'
  difficulty: '상' | '중' | '하'
  description: string
  mainFlow: string
  altFlow?: string
  precondition: string
  postcondition: string
  actors: string[]
}

export interface ExampleRow {
  d1: string
  d2: string
  reqId: string
  reqName: string
  ucs: ExampleUseCase[]
}

export const ACTORS = [
  {
    kind: 'Primary',
    name: '시스템관리자',
    description: '플랫폼 전체 관리, 권한/메뉴/회원 관리, 표준코드 관리',
    note: '내부'
  },
  {
    kind: 'Primary',
    name: '정책담당자',
    description: '주요 정보 조회, 분석 도구 활용, 리스크 진단 결과 확인 (공무원)',
    note: '내부'
  },
  {
    kind: 'Primary',
    name: '전문가',
    description: '데이터 분석, 연구 자료 활용 (연구자/산업계)',
    note: '내부'
  },
  { kind: 'Primary', name: '일반국민', description: '공개 정보 열람, 알람 수신', note: '외부' },
  {
    kind: 'Secondary',
    name: '연계기관시스템',
    description: '외부기관A/외부기관B 부문 외부 시스템 (OpenAPI/파일연계)',
    note: '외부'
  }
]

export const ROWS: ExampleRow[] = [
  {
    d1: '통합서비스',
    d2: '분야별 연계서비스',
    reqId: 'SFR-001-PAD(플랫폼기반)-02',
    reqName: '분야별 연계 기반 통합서비스 기능 구현',
    ucs: [
      {
        name: '연계 데이터 수집',
        priority: 'High',
        difficulty: '상',
        description: '외부기관A/외부기관B 부문 관련 시스템 2건 이상을 OpenAPI 또는 파일로 수집한다.',
        mainFlow:
          '1. 연계대상시스템을 선택한다\n2. OpenAPI를 호출하거나 파일을 다운로드한다\n3. 원시데이터를 sampledb에 저장한다\n4. 수집 결과를 확인한다',
        precondition: '연계대상시스템 분석 완료, API키 발급',
        postcondition: '원시 연계데이터 저장 완료',
        actors: ['시스템관리자', '연계기관시스템']
      },
      {
        name: '수집 데이터 표준화',
        priority: 'High',
        difficulty: '상',
        description: '수집한 원시데이터를 정합성 검증 후 표준코드 표준으로 가공해 정형DB에 적재한다.',
        mainFlow:
          '1. 원시데이터 정합성을 검증한다\n2. 정제 처리를 수행한다\n3. 표준코드 표준으로 가공한다\n4. 정형DB(sampledb)에 저장한다',
        altFlow: '2a. 검증 실패 시 오류 이력을 남기고 재수집을 요청한다',
        precondition: '원시데이터 수집 완료',
        postcondition: '표준화 데이터 적재 완료',
        actors: ['시스템관리자']
      }
    ]
  },
  {
    d1: '통합서비스',
    d2: '알람서비스',
    reqId: 'SFR-001-PAD(플랫폼기반)-03',
    reqName: '관심 주제 키워드 기반 공고, 인프라 등 알람 기능 구현',
    ucs: [
      {
        name: '관심 키워드 등록',
        priority: 'Medium',
        difficulty: '중',
        description: '사용자가 알람을 받을 관심 주제 키워드를 등록한다.',
        mainFlow: '1. 알람설정 화면에 진입한다\n2. 관심 키워드를 입력한다\n3. 저장한다',
        precondition: '로그인 상태',
        postcondition: '관심키워드 등록 완료',
        actors: ['정책담당자', '일반국민']
      },
      {
        name: '키워드 알람 수신',
        priority: 'Medium',
        difficulty: '중',
        description:
          '신규 공고/인프라 정보가 관심 키워드와 매칭되면 메인 화면에 팝업으로 노출한다.',
        mainFlow:
          '1. 신규 공고/인프라 정보를 수집한다\n2. 등록된 키워드와 매칭한다\n3. 알람을 생성한다\n4. 메인 화면에 팝업으로 노출한다',
        precondition: '사용자 관심키워드 등록',
        postcondition: '알람 노출 완료',
        actors: ['정책담당자', '일반국민']
      }
    ]
  },
  {
    d1: '데이터관리',
    d2: '표준코드 DB관리',
    reqId: 'SFR-002-PAD(플랫폼기반)-04',
    reqName: '표준코드기반 DB 구축설계 및 등록수정관리 시스템 개발',
    ucs: [
      {
        name: '표준코드 관리',
        priority: 'High',
        difficulty: '상',
        description: '표준분류체계 코드를 등록/수정/삭제한다.',
        mainFlow:
          '1. 표준코드 관리 화면에 진입한다\n2. 대/중/소/세분류를 선택한다\n3. 표준코드를 등록·수정한다\n4. 저장한다',
        precondition: '시스템관리 권한 보유',
        postcondition: '표준코드 반영 완료',
        actors: ['시스템관리자']
      },
      {
        name: '데이터 품질 이력 관리',
        priority: 'High',
        difficulty: '상',
        description: '원시→정제→가공 각 단계 이력과 가공 버전을 저장해 품질을 추적한다.',
        mainFlow:
          '1. 원시정보를 저장한다\n2. 일관성을 검증한다(중복제거, 속성정리)\n3. 정제 처리 후 이력을 저장한다\n4. 가공 결과를 버전별로 저장한다',
        precondition: '원시데이터 수집 완료',
        postcondition: '품질관리 이력 및 버전 생성',
        actors: ['시스템관리자']
      }
    ]
  },
  {
    d1: '데이터관리',
    d2: '양방향연결구조',
    reqId: 'SFR-014-PAD(플랫폼기반)-01',
    reqName: '표준코드기반으로 주요 대책의 리스크를 포함한 양방향연결구조 설계',
    ucs: [
      {
        name: '분류A-분류B-분류C 연결관계 정의',
        priority: 'High',
        difficulty: '상',
        description: '과학기반(SCI)·적응해법(SOL)·정책평가(PEV) 세부분류 간 연결 구조를 정의한다.',
        mainFlow:
          '1. 표준분류체계를 조회한다\n2. 대/중/소/세분류를 선택한다\n3. 분류A-분류B-분류C 연결관계를 정의한다\n4. 양방향 링크를 생성한다\n5. 연결구조를 저장한다',
        precondition: '표준분류체계 정의 완료',
        postcondition: '양방향 연결구조 설계 완료',
        actors: ['시스템관리자', '전문가']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: '연계서비스표준',
    reqId: 'SFR-003-PAD(플랫폼기반)-01',
    reqName: '연계기관 데이터별 연계 서비스 표준 구축 및 기관 연동 시스템 구축',
    ucs: [
      {
        name: '연계 인터페이스 설정',
        priority: 'High',
        difficulty: '상',
        description: '연계대상기관별 연계방식을 결정하고 연동 인터페이스를 설정한다.',
        mainFlow:
          '1. 연계대상기관을 선택한다\n2. 연계방식을 결정한다(실시간API/파일업로드)\n3. 연동 인터페이스를 설정한다\n4. 테스트 연계를 수행한다\n5. 운영 연계로 전환한다',
        altFlow: '4a. 테스트 실패 시 인터페이스 설정 단계로 되돌아간다',
        precondition: '연계대상시스템분석서 작성 완료',
        postcondition: '기관 연동 시스템 구축 완료',
        actors: ['시스템관리자', '연계기관시스템']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: '연계현황모니터링',
    reqId: 'SFR-003-PAD(플랫폼기반)-04',
    reqName: '과학기반정보제공 연계기관 연동 진행 현황 모니터링',
    ucs: [
      {
        name: '연계 현황 조회',
        priority: 'High',
        difficulty: '중',
        description: '연동기관·수집형식·수집주기·장애여부 등 연계 현황과 이력을 조회한다.',
        mainFlow:
          '1. 연계현황 메뉴에 접근한다\n2. 연동기관 목록을 조회한다\n3. 수집주기별 데이터 건수를 확인한다\n4. 장애여부를 확인한다\n5. 상세이력을 조회한다',
        precondition: '연계시스템 구축 완료',
        postcondition: '모니터링 현황 조회 완료',
        actors: ['시스템관리자']
      },
      {
        name: '수동 재수집 실행',
        priority: 'Medium',
        difficulty: '중',
        description: '장애 또는 누락이 확인된 연계 건을 수동으로 재수집한다.',
        mainFlow: '1. 장애 건을 선택한다\n2. 재수집을 실행한다\n3. 수집 결과를 확인한다',
        precondition: '장애 이력 존재',
        postcondition: '재수집 완료',
        actors: ['시스템관리자', '연계기관시스템']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: 'OpenAPI플랫폼',
    reqId: 'SFR-009-PAD(플랫폼기반)-01',
    reqName: '기관간 정보공유를 위한 Open API기반 통합플랫폼구축',
    ucs: [
      {
        name: 'API 수집 스케줄 관리',
        priority: 'High',
        difficulty: '상',
        description: '중계서버에서 수집대상 API와 수집 스케줄을 설정하고 실행한다.',
        mainFlow:
          '1. 중계서버에 접속한다\n2. 수집대상 API를 선택한다\n3. 수집 스케줄을 설정한다\n4. API를 호출해 데이터를 수집한다\n5. 원시데이터를 저장한다',
        precondition: '중계서버 구축 완료',
        postcondition: 'API 데이터 수집 완료',
        actors: ['시스템관리자', '연계기관시스템']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: '과학해법정책연계',
    reqId: 'SFR-009-PAD(플랫폼기반)-02',
    reqName: '과학(자료)-해법(대응방안)-정책(대책) 연계 체계 구현',
    ucs: [
      {
        name: '표준분류체계 탐색',
        priority: 'High',
        difficulty: '상',
        description: '분류A/분류B/분류C 대분류부터 소분류까지 탐색하며 표준코드와 연결관계를 확인한다.',
        mainFlow:
          '1. 표준분류체계 메뉴에 접근한다\n2. 대분류를 선택한다(분류A/분류B/분류C)\n3. 중분류/소분류를 탐색한다\n4. 표준코드를 조회한다\n5. 데이터 연결관계를 확인한다',
        precondition: '표준분류체계 정의 완료',
        postcondition: '연계체계 조회 완료',
        actors: ['정책담당자', '전문가']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: '거버넌스연동',
    reqId: 'SFR-009-PAD(플랫폼기반)-03',
    reqName: '범부처 협력을 위한 거버넌스 체계와 연동',
    ucs: [
      {
        name: '기관 연계 협의 진행',
        priority: 'Medium',
        difficulty: '중',
        description: '범부처 협력을 위한 연계 협의를 요청하고 연계방식을 확정한다.',
        mainFlow:
          '1. 연계협의를 요청한다\n2. 기관 협의를 진행한다\n3. 연계방식을 결정한다\n4. 분석/설계를 수행한다\n5. 출처표시 링크를 설정한다',
        precondition: '기관 간 협의 채널 확보',
        postcondition: '거버넌스 연동 완료',
        actors: ['시스템관리자', '정책담당자']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: '데이터품질검증',
    reqId: 'SFR-009-PAD(플랫폼기반)-04',
    reqName: 'API 연계를 위한 데이터 품질 검증 시스템 구축',
    ucs: [
      {
        name: '정합성 검증 수행',
        priority: 'High',
        difficulty: '상',
        description: '전문구조·필수항목·데이터타입·코드값을 검증한다.',
        mainFlow:
          '1. 원시정보를 저장한다\n2. 전문구조를 검증한다\n3. 필수항목을 검증한다\n4. 데이터타입을 검증한다\n5. 코드값을 검증한다',
        altFlow: '2a~5a. 검증 실패 항목은 오류 코드와 함께 이력에 기록한다',
        precondition: '데이터 수집 완료',
        postcondition: '정합성 검증 결과 생성',
        actors: ['시스템관리자']
      },
      {
        name: '표준코드 구조 재정의 및 버전 저장',
        priority: 'High',
        difficulty: '상',
        description: '일관성 처리 후 표준코드 구조로 재정의하고 버전별 이력을 저장한다.',
        mainFlow:
          '1. 일관성 처리를 수행한다\n2. 표준코드 구조로 재정의한다\n3. 버전별 이력을 저장한다',
        precondition: '정합성 검증 완료',
        postcondition: '품질검증 및 버전 저장 완료',
        actors: ['시스템관리자']
      }
    ]
  },
  {
    d1: '연계관리',
    d2: '데이터수집설계',
    reqId: 'SFR-012-PAD(플랫폼기반)-01',
    reqName: '내·외부 데이터 수집 기능 설계',
    ucs: [
      {
        name: '수집 통계 및 장애 분석',
        priority: 'High',
        difficulty: '상',
        description: '연계 현황 통계와 수집 추이 차트, 장애 로그를 확인한다.',
        mainFlow:
          '1. 연계현황 통계를 조회한다\n2. 수집데이터 추이 차트를 확인한다\n3. 장애로그를 조회한다\n4. 실패/장애 상세 팝업을 확인한다\n5. 재수집을 요청한다',
        precondition: '연계시스템 운영 중',
        postcondition: '수집현황 파악 완료',
        actors: ['시스템관리자']
      }
    ]
  },
  {
    d1: '시스템관리',
    d2: '권한관리',
    reqId: 'SFR-005-PAD(플랫폼기반)-01',
    reqName: '사용자 권한별 맞춤 서비스 제공',
    ucs: [
      {
        name: '사용자 권한 설정',
        priority: 'High',
        difficulty: '중',
        description: '사용자를 권한그룹에 배정하고 접근 가능 메뉴를 설정한다.',
        mainFlow:
          '1. 권한관리 메뉴에 접근한다\n2. 사용자를 조회한다\n3. 권한그룹을 선택한다\n4. 접근가능 메뉴를 설정한다\n5. 권한을 저장한다',
        precondition: '사용자 등록 완료',
        postcondition: '권한 설정 완료',
        actors: ['시스템관리자']
      },
      {
        name: '권한별 맞춤 화면 제공',
        priority: 'High',
        difficulty: '중',
        description: '대국민/정책담당자/전문가 권한에 따라 서로 다른 메뉴와 화면을 제공한다.',
        mainFlow:
          '1. 사용자가 로그인한다\n2. 권한그룹을 확인한다\n3. 권한별 메뉴를 구성해 제공한다',
        precondition: '권한 설정 완료',
        postcondition: '맞춤 화면 노출',
        actors: ['정책담당자', '전문가', '일반국민']
      }
    ]
  },
  {
    d1: '시스템관리',
    d2: '관리자포털',
    reqId: 'SFR-005-PAD(플랫폼기반)-02',
    reqName: '회원, 권한, 메뉴, 컨텐츠관리, 로그, 게시판관리, 통합검색 등 관리자포털 기능 제공',
    ucs: [
      {
        name: '공통 관리 기능 운영',
        priority: 'High',
        difficulty: '중',
        description: '공통코드/메시지/메뉴/회원 등 eGovFrame 기반 시스템관리 기능을 운영한다.',
        mainFlow:
          '1. 시스템관리 메뉴에 접근한다\n2. 공통코드/메시지/권한/메뉴/회원을 관리한다\n3. 변경 내용을 저장한다',
        precondition: '관리자 권한 보유',
        postcondition: '시스템관리 작업 완료',
        actors: ['시스템관리자']
      },
      {
        name: '게시판·게시물 관리',
        priority: 'Medium',
        difficulty: '중',
        description: '게시판과 게시물을 등록/수정/삭제하고 이력 현황을 조회한다.',
        mainFlow:
          '1. 게시판 관리에 접근한다\n2. 게시판/게시물을 관리한다\n3. 이력현황을 조회한다',
        precondition: '관리자 권한 보유',
        postcondition: '게시판 관리 완료',
        actors: ['시스템관리자']
      }
    ]
  },
  {
    d1: '시스템관리',
    d2: '운영관리',
    reqId: 'SFR-006-PAD(플랫폼기반)-01',
    reqName: '통합플랫폼 운영 관리를 위한 관리자 기능개발',
    ucs: [
      {
        name: '운영 현황 모니터링',
        priority: 'High',
        difficulty: '상',
        description: '로그인/메뉴접근/파일다운로드 현황을 조회하고 시각화한다.',
        mainFlow:
          '1. 모니터링 메뉴에 접근한다\n2. 로그인/메뉴접근/파일다운로드 현황을 조회한다\n3. 통계검색 조건을 설정한다\n4. 시각화 결과를 확인한다',
        precondition: '관리자 권한 보유',
        postcondition: '운영현황 파악 완료',
        actors: ['시스템관리자']
      },
      {
        name: '통계 엑셀 다운로드',
        priority: 'Medium',
        difficulty: '중',
        description: '조회한 통계 현황을 엑셀 파일로 내려받는다.',
        mainFlow:
          '1. 조회 결과에서 다운로드를 선택한다\n2. 엑셀 파일을 생성한다\n3. 파일을 내려받는다',
        precondition: '통계 조회 완료',
        postcondition: '엑셀 파일 다운로드 완료',
        actors: ['시스템관리자']
      }
    ]
  },
  {
    d1: '분석진단',
    d2: '리스크진단알고리즘',
    reqId: 'SFR-011-PAD(플랫폼기반)-02',
    reqName: '표준코드 양방향 연결체계기반 국가 리스크 진단 알고리즘 시범구축',
    ucs: [
      {
        name: '리스크 진단 실행',
        priority: 'High',
        difficulty: '상',
        description: '표준코드 양방향 연결체계를 기반으로 부문별 리스크를 진단한다.',
        mainFlow:
          '1. 표준분류체계를 조회한다\n2. 분류A/분류B/분류C 대분류를 선택한다\n3. 등급구분을 코드화한다\n4. 연결고리를 설정한다\n5. 리스크 진단을 실행한다',
        precondition: '데이터 표준화 완료',
        postcondition: '리스크 진단 결과 생성',
        actors: ['정책담당자', '전문가']
      },
      {
        name: '진단 결과 확인',
        priority: 'High',
        difficulty: '중',
        description: '진단 결과를 조회하고 근거 데이터를 확인한다.',
        mainFlow:
          '1. 진단 결과 목록을 조회한다\n2. 상세 결과를 확인한다\n3. 근거 데이터를 확인한다',
        precondition: '리스크 진단 실행 완료',
        postcondition: '진단 결과 확인 완료',
        actors: ['정책담당자']
      }
    ]
  },
  {
    d1: '공통기능',
    d2: '사전경고',
    reqId: 'PER-006-PAD(플랫폼기반)-01',
    reqName: '느린 작업에 대한 사전 경고',
    ucs: [
      {
        name: '장시간 작업 사전 경고',
        priority: 'Low',
        difficulty: '하',
        description: '통계조회·자료생성·외부연계 등 시간이 오래 걸리는 작업 전에 알람을 노출한다.',
        mainFlow:
          '1. 사용자가 작업을 요청한다\n2. 예상 처리시간을 산정한다\n3. 임계값 초과 시 알람팝업을 생성한다\n4. 메시지를 노출한다\n5. 사용자가 확인한다',
        altFlow: '5a. 사용자가 취소하면 작업을 중단한다',
        precondition: '없음',
        postcondition: '사전경고 노출 완료',
        actors: ['정책담당자', '전문가', '일반국민']
      }
    ]
  }
]
