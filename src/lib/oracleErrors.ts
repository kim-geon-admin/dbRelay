export type OracleErrorInfo = {
  name: string;
  description: string;
};

export const ORACLE_ERROR_CATALOG: Readonly<Record<string, OracleErrorInfo>> = {
  "ORA-00001": { name: "고유 제약 조건 위반", description: "동일한 값이 이미 존재합니다. 중복 키 또는 고유 인덱스를 확인하세요." },
  "ORA-00054": { name: "리소스 사용 중", description: "다른 세션이 객체 잠금을 보유하고 있습니다. 잠금이 해제된 뒤 다시 시도하거나 대기 시간을 조정하세요." },
  "ORA-00060": { name: "교착 상태 감지", description: "서로 대기하는 트랜잭션이 감지되었습니다. 트랜잭션 순서와 잠금 범위를 검토한 뒤 다시 시도하세요." },
  "ORA-00900": { name: "잘못된 SQL 문", description: "Oracle에서 지원하는 SQL 문인지, 키워드와 문장 구조가 올바른지 확인하세요." },
  "ORA-00904": { name: "잘못된 식별자", description: "컬럼 또는 객체 이름의 철자, 따옴표 사용, 대소문자, 예약어 사용 여부를 확인하세요." },
  "ORA-00911": { name: "잘못된 문자", description: "SQL에 허용되지 않은 문자가 포함되어 있습니다. 세미콜론, 특수문자, 식별자 표기를 확인하세요." },
  "ORA-00913": { name: "값이 너무 많음", description: "INSERT 대상 컬럼 수와 VALUES 또는 SELECT의 값 수가 일치하는지 확인하세요." },
  "ORA-00918": { name: "컬럼 이름 모호함", description: "조인 또는 서브쿼리에서 중복된 컬럼 이름을 테이블 별칭으로 명확히 지정하세요." },
  "ORA-00933": { name: "SQL 명령이 올바르게 종료되지 않음", description: "지원되지 않는 절, 잘못된 키워드 순서, 문자열 따옴표를 확인하세요." },
  "ORA-00936": { name: "표현식 누락", description: "SELECT, WHERE, SET 또는 VALUES 절에 필요한 컬럼, 값, 연산자가 있는지 확인하세요." },
  "ORA-00947": { name: "값이 부족함", description: "INSERT 대상 컬럼 수와 제공한 값 또는 SELECT 컬럼 수를 일치시키세요." },
  "ORA-00955": { name: "이미 사용 중인 객체 이름", description: "동일한 이름의 테이블, 인덱스, 뷰 등 객체가 있는지 확인하고 다른 이름을 사용하세요." },
  "ORA-00957": { name: "중복 컬럼 이름", description: "SELECT 목록, CREATE TABLE 또는 ALTER TABLE의 중복 컬럼 이름을 수정하세요." },
  "ORA-00972": { name: "식별자 길이 초과", description: "테이블, 컬럼, 별칭 등 식별자 길이가 Oracle 버전의 제한을 넘지 않는지 확인하세요." },
  "ORA-00979": { name: "GROUP BY 표현식 아님", description: "집계하지 않는 SELECT 컬럼을 GROUP BY에 추가하거나 집계 함수로 처리하세요." },
  "ORA-01000": { name: "열린 커서 한도 초과", description: "커서를 닫고 재사용하거나 OPEN_CURSORS 설정을 관리자와 검토하세요." },
  "ORA-01008": { name: "모든 바인드 변수가 바인드되지 않음", description: "SQL의 모든 바인드 변수에 값이 전달되는지 이름과 개수를 확인하세요." },
  "ORA-01045": { name: "CREATE SESSION 권한 없음", description: "접속 계정에 CREATE SESSION 권한이 있는지 관리자에게 확인하세요." },
  "ORA-01093": { name: "Oracle 종료 중", description: "데이터베이스가 종료 중입니다. 기동이 완료된 뒤 다시 연결하세요." },
  "ORA-00942": { name: "테이블 또는 뷰가 존재하지 않음", description: "객체 이름, 스키마, 그리고 조회 권한을 확인하세요." },
  "ORA-01017": { name: "사용자 이름 또는 비밀번호가 올바르지 않음", description: "접속 계정 정보와 계정 상태를 확인하세요." },
  "ORA-01031": { name: "권한 부족", description: "실행 계정에 필요한 객체 권한이 있는지 확인하세요." },
  "ORA-01400": { name: "NULL 값을 삽입할 수 없음", description: "필수 컬럼에 값이 매핑되었는지 확인하세요." },
  "ORA-01403": { name: "데이터를 찾을 수 없음", description: "단일 행 조회 또는 PL/SQL 처리 대상 데이터가 존재하는지 조건을 확인하세요." },
  "ORA-01427": { name: "단일 행 서브쿼리가 여러 행을 반환함", description: "서브쿼리가 한 행만 반환하도록 조건을 좁히거나 IN, EXISTS 등으로 의도를 표현하세요." },
  "ORA-01438": { name: "정밀도보다 큰 값", description: "NUMBER 컬럼의 자릿수와 소수 자릿수에 맞는 값을 전달하세요." },
  "ORA-01461": { name: "LONG 값만 LONG 컬럼에 바인드 가능", description: "대용량 문자열 또는 바이너리 값의 컬럼 타입과 바인드 방식을 확인하세요." },
  "ORA-01489": { name: "문자열 연결 결과가 너무 김", description: "문자열 연결 결과의 길이를 줄이거나 CLOB 처리를 사용하세요." },
  "ORA-01555": { name: "스냅샷이 너무 오래됨", description: "장시간 조회 중 필요한 UNDO가 사라졌습니다. UNDO 보존 기간 또는 트랜잭션 범위를 검토하세요." },
  "ORA-01653": { name: "테이블 확장 공간 부족", description: "테이블스페이스의 여유 공간과 데이터 파일 확장 설정을 관리자와 확인하세요." },
  "ORA-01722": { name: "잘못된 숫자", description: "숫자로 변환되는 값에 숫자가 아닌 문자가 없는지 데이터와 변환식을 확인하세요." },
  "ORA-01756": { name: "문자열 리터럴이 올바르게 종료되지 않음", description: "작은따옴표를 쌍으로 이스케이프하고 문자열의 시작과 끝을 확인하세요." },
  "ORA-01830": { name: "날짜 형식 문자열이 끝나기 전에 입력이 끝남", description: "입력 날짜 값의 길이와 TO_DATE 또는 TO_TIMESTAMP 형식 모델을 일치시키세요." },
  "ORA-01843": { name: "잘못된 월", description: "날짜 문자열의 월 값과 NLS 설정 또는 날짜 형식 모델을 확인하세요." },
  "ORA-01858": { name: "숫자가 필요한 위치에 숫자가 아닌 문자가 있음", description: "날짜·시간 또는 숫자 변환 입력값과 형식 모델을 확인하세요." },
  "ORA-01861": { name: "리터럴이 형식 문자열과 일치하지 않음", description: "입력값과 날짜·시간 형식 문자열의 구성과 길이를 일치시키세요." },
  "ORA-01950": { name: "테이블스페이스 할당량 부족", description: "계정에 대상 테이블스페이스의 할당량이 있는지 관리자에게 확인하세요." },
  "ORA-02049": { name: "분산 트랜잭션 잠금 대기 시간 초과", description: "원격 데이터베이스 연결과 잠금 보유 트랜잭션을 확인한 뒤 다시 시도하세요." },
  "ORA-02290": { name: "체크 제약 조건 위반", description: "입력값이 CHECK 제약 조건을 만족하는지 대상 테이블의 규칙을 확인하세요." },
  "ORA-02291": { name: "상위 키를 찾을 수 없음", description: "참조 대상의 상위 데이터가 먼저 존재하는지 확인하세요." },
  "ORA-02292": { name: "하위 레코드가 존재함", description: "참조 중인 하위 데이터를 먼저 처리하세요." },
  "ORA-02443": { name: "제약 조건이 존재하지 않음", description: "제약 조건 이름과 대상 테이블 또는 스키마를 확인하세요." },
  "ORA-03114": { name: "Oracle에 연결되지 않음", description: "세션이 종료되었거나 연결이 끊겼습니다. 연결을 다시 만들고 작업을 재시도하세요." },
  "ORA-03135": { name: "연결이 끊김", description: "데이터베이스 또는 네트워크 연결이 끊겼습니다. 네트워크와 서버 상태를 확인하고 재연결하세요." },
  "ORA-03113": { name: "통신 채널 연결 종료", description: "데이터베이스 연결이 끊겼습니다. 네트워크와 데이터베이스 상태를 확인하세요." },
  "ORA-04043": { name: "객체가 존재하지 않음", description: "객체 이름, 스키마, 대소문자와 객체 생성 여부를 확인하세요." },
  "ORA-04061": { name: "기존 패키지 상태가 무효화됨", description: "의존 객체가 변경되었습니다. 세션을 다시 연결하거나 패키지를 다시 초기화하세요." },
  "ORA-04068": { name: "패키지 상태가 삭제됨", description: "패키지 또는 의존 객체가 변경되었습니다. 작업을 다시 실행하고 필요한 경우 세션을 재연결하세요." },
  "ORA-06502": { name: "PL/SQL 숫자 또는 값 오류", description: "변수 길이, 숫자 정밀도, 문자열·숫자 변환 값을 확인하세요." },
  "ORA-06512": { name: "PL/SQL 호출 스택", description: "이 코드는 원인 오류의 발생 위치를 알려줍니다. 함께 표시된 선행 ORA 오류를 먼저 확인하세요." },
  "ORA-12154": { name: "접속 식별자를 해석할 수 없음", description: "호스트, 포트, 서비스 이름 설정을 확인하세요." },
  "ORA-12170": { name: "연결 시간 초과", description: "호스트·포트 접근성, 방화벽, 리스너 상태와 연결 시간 초과 설정을 확인하세요." },
  "ORA-12505": { name: "리스너가 요청한 SID를 알 수 없음", description: "SID 설정과 리스너에 등록된 인스턴스 이름을 확인하세요." },
  "ORA-12514": { name: "리스너가 요청한 서비스를 알 수 없음", description: "서비스 이름과 리스너 등록 상태를 확인하세요." },
  "ORA-12516": { name: "리스너가 적절한 핸들러를 찾을 수 없음", description: "데이터베이스 프로세스 또는 세션 한도가 부족할 수 있습니다. 관리자에게 리소스 상태를 확인하세요." },
  "ORA-12519": { name: "리스너가 적절한 서비스 핸들러를 찾을 수 없음", description: "데이터베이스의 프로세스 또는 세션 한도와 리스너 등록 상태를 확인하세요." },
  "ORA-12537": { name: "연결이 닫힘", description: "리스너 또는 네트워크가 연결을 닫았습니다. 서버 로그와 네트워크 상태를 확인하세요." },
  "ORA-12541": { name: "리스너가 없음", description: "호스트, 포트, 그리고 Oracle 리스너 실행 상태를 확인하세요." },
  "ORA-12543": { name: "대상 호스트에 연결할 수 없음", description: "호스트 이름, DNS, 네트워크 경로와 방화벽 설정을 확인하세요." },
  "ORA-12545": { name: "대상 호스트 또는 객체가 없음", description: "접속 문자열의 호스트·포트와 네트워크 접근성을 확인하세요." },
  "ORA-12899": { name: "컬럼 값이 너무 큼", description: "문자열 또는 바이트 길이가 대상 컬럼의 최대 길이를 넘지 않는지 확인하세요." },
  "ORA-28000": { name: "계정 잠김", description: "Oracle 관리자에게 계정 잠금 해제를 요청하세요." },
  "ORA-28001": { name: "비밀번호 만료", description: "접속 계정의 비밀번호를 변경한 뒤 연결 설정을 업데이트하세요." },
  "ORA-28002": { name: "비밀번호 만료 예정", description: "접속은 가능하지만 비밀번호 만료가 임박했습니다. 운영 중단 전에 비밀번호를 변경하세요." },
  "ORA-28003": { name: "비밀번호 검증 실패", description: "비밀번호 정책을 만족하는 새 비밀번호를 사용하세요." },
  "ORA-20000": { name: "애플리케이션 오류", description: "데이터베이스의 애플리케이션 오류 로그를 확인하세요." },
  "ORA-00018": { name: "최대 세션 수 초과", description: "데이터베이스의 세션 한도에 도달했습니다. 유휴 세션과 세션 한도를 확인하세요." },
  "ORA-00020": { name: "최대 프로세스 수 초과", description: "데이터베이스 프로세스 한도에 도달했습니다. 유휴 연결과 프로세스 설정을 확인하세요." },
  "ORA-00907": { name: "오른쪽 괄호 누락", description: "SQL의 괄호 짝과 함수·서브쿼리 구문을 확인하세요." },
  "ORA-00917": { name: "쉼표 누락", description: "SELECT 목록, 컬럼 목록 또는 VALUES 절의 쉼표를 확인하세요." },
  "ORA-00923": { name: "FROM 키워드를 찾을 수 없음", description: "SELECT 문에서 FROM 절과 컬럼 별칭 구문을 확인하세요." },
  "ORA-00932": { name: "데이터 형식 불일치", description: "비교·연산·바인드에 사용한 값과 컬럼의 데이터 형식을 맞추세요." },
  "ORA-00934": { name: "그룹 함수 사용 위치 오류", description: "집계 함수는 WHERE 절이 아닌 HAVING 절 또는 적절한 SELECT 절에서 사용하세요." },
  "ORA-00937": { name: "단일 그룹 그룹 함수 아님", description: "집계하지 않은 컬럼은 GROUP BY 절에 포함하세요." },
  "ORA-00984": { name: "컬럼을 사용할 수 없음", description: "VALUES 절에 컬럼명 대신 바인드 변수 또는 리터럴 값을 사용하세요." },
  "ORA-01007": { name: "선택 목록 변수 범위 오류", description: "SELECT 목록과 조회 결과를 받는 변수 구성을 일치시키세요." },
  "ORA-01036": { name: "바인드 변수 이름 또는 번호 오류", description: "SQL의 바인드 변수 이름과 전달한 바인드 값을 확인하세요." },
  "ORA-01422": { name: "단일 행 조회 결과 초과", description: "단일 행을 기대하는 조회가 여러 행을 반환했습니다. 조건 또는 조회 방식을 검토하세요." },
  "ORA-01476": { name: "0으로 나누기", description: "나눗셈의 분모가 0이 되는 데이터를 처리하세요." },
  "ORA-01536": { name: "테이블스페이스 할당량 초과", description: "계정의 테이블스페이스 할당량과 사용량을 확인하세요." },
  "ORA-01652": { name: "임시 세그먼트 확장 실패", description: "TEMP 테이블스페이스의 여유 공간과 대용량 정렬·해시 작업을 확인하세요." },
  "ORA-01917": { name: "사용자 또는 롤이 없음", description: "권한을 부여하거나 참조한 사용자·롤 이름을 확인하세요." },
  "ORA-02019": { name: "원격 데이터베이스 연결 설명을 찾을 수 없음", description: "데이터베이스 링크와 원격 접속 설명을 확인하세요." },
  "ORA-02068": { name: "원격 데이터베이스 오류", description: "데이터베이스 링크 대상의 앞선 오류와 연결 상태를 확인하세요." },
  "ORA-02289": { name: "시퀀스가 없음", description: "시퀀스 이름, 스키마, 접근 권한을 확인하세요." },
  "ORA-04021": { name: "객체 잠금 대기 시간 초과", description: "다른 세션의 DDL 잠금을 확인한 뒤 다시 시도하세요." },
  "ORA-04031": { name: "공유 메모리 할당 실패", description: "공유 풀 메모리와 SQL 파싱 부하를 확인하세요." },
  "ORA-04098": { name: "트리거가 유효하지 않음", description: "트리거 컴파일 오류와 참조 객체 상태를 확인하세요." },
  "ORA-06500": { name: "PL/SQL 저장 공간 부족", description: "PL/SQL 처리량과 메모리 사용량을 확인하세요." },
  "ORA-06550": { name: "PL/SQL 컴파일 오류", description: "표시된 행의 PL/SQL 구문과 참조 객체를 확인하세요." },
  "ORA-08177": { name: "트랜잭션 직렬화 실패", description: "동시 변경이 충돌했습니다. 트랜잭션을 다시 시도하세요." },
  "ORA-12162": { name: "서비스 이름 설정 오류", description: "접속 식별자와 Oracle Net 설정을 확인하세요." },
  "ORA-12560": { name: "프로토콜 어댑터 오류", description: "Oracle 클라이언트 환경과 리스너 연결 상태를 확인하세요." },
  "ORA-12571": { name: "패킷 기록 실패", description: "네트워크 연결과 Oracle Net 로그를 확인하세요." },
  "ORA-12705": { name: "NLS 데이터 파일 또는 환경 오류", description: "문자 집합과 NLS 환경 변수를 확인하세요." },
};

const ORACLE_ERROR_KOREAN_EXPLANATIONS: Readonly<Record<string, string>> = {
  "ORA-00900": "유효하지 않은 SQL 문입니다",
  "ORA-00901": "유효하지 않은 CREATE 명령입니다",
  "ORA-00902": "유효하지 않은 데이터 유형입니다",
  "ORA-00903": "유효하지 않은 테이블 이름입니다",
  "ORA-00904": "유효하지 않은 식별자입니다 (존재하지 않는 컬럼명 등)",
  "ORA-00905": "키워드가 누락되었습니다",
  "ORA-00906": "왼쪽 괄호가 누락되었습니다",
  "ORA-00907": "오른쪽 괄호가 누락되었습니다",
  "ORA-00908": "NULL 키워드가 누락되었습니다",
  "ORA-00909": "인자(argument)의 개수가 잘못되었습니다",
  "ORA-00910": "해당 데이터 유형에 비해 길이가 너무 깁니다",
  "ORA-00911": "유효하지 않은 문자입니다",
  "ORA-00913": "값이 너무 많습니다",
  "ORA-00914": "EXPRESSION 키워드가 누락되었습니다",
  "ORA-00917": "콤마(,)가 누락되었습니다",
  "ORA-00918": "컬럼이 모호하게 정의되었습니다 (중복 컬럼명)",
  "ORA-00920": "유효하지 않은 관계 연산자입니다",
  "ORA-00921": "SQL 명령이 예기치 않게 끝났습니다",
  "ORA-00922": "옵션이 누락되었거나 유효하지 않습니다",
  "ORA-00923": "예상되는 위치에 FROM 키워드가 없습니다",
  "ORA-00924": "BY 키워드가 누락되었습니다",
  "ORA-00925": "INTO 키워드가 누락되었습니다",
  "ORA-00926": "VALUES 키워드가 누락되었습니다",
  "ORA-00928": "SELECT 키워드가 누락되었습니다",
  "ORA-00931": "식별자가 누락되었습니다",
  "ORA-00932": "데이터 유형이 일치하지 않습니다",
  "ORA-00933": "SQL 명령이 올바르게 종료되지 않았습니다",
  "ORA-00934": "이 위치에서는 그룹 함수를 사용할 수 없습니다",
  "ORA-00936": "표현식(expression)이 누락되었습니다",
  "ORA-00937": "단일 그룹 함수가 아닙니다",
  "ORA-00938": "함수에 대한 인자가 부족합니다",
  "ORA-00939": "함수에 대한 인자가 너무 많습니다",
  "ORA-00941": "유효하지 않은 스키마 이름입니다",
  "ORA-00944": "유효하지 않은 컬럼 이름입니다",
  "ORA-00970": "WITH 키워드가 누락되었습니다",
  "ORA-00971": "SET 키워드가 누락되었습니다",
  "ORA-00972": "식별자(테이블/컬럼명 등)가 너무 깁니다 (30바이트/128바이트 초과)",
  "ORA-00979": "GROUP BY 표현식이 아닙니다",
  "ORA-00983": "NULL을 삽입할 수 없습니다",
  "ORA-00984": "이 위치에서는 컬럼을 사용할 수 없습니다",
  "ORA-00987": "사용자명이 누락되었거나 유효하지 않습니다",
};

const ORACLE_ERROR_RANGES: ReadonlyArray<{ from: number; to: number; info: OracleErrorInfo }> = [
  { from: 0, to: 899, info: { name: "Oracle 인스턴스 오류", description: "Oracle 인스턴스와 시스템 상태를 확인하세요." } },
  { from: 900, to: 1499, info: { name: "SQL 구문 또는 실행 오류", description: "SQL 구문, 객체 이름, 권한, 그리고 입력 값을 확인하세요." } },
  { from: 1500, to: 2098, info: { name: "데이터베이스 저장소 또는 트랜잭션 오류", description: "트랜잭션 상태와 데이터베이스 저장소 상태를 확인하세요." } },
  { from: 2100, to: 4999, info: { name: "Oracle SQL 실행 오류", description: "SQL 실행 조건과 데이터베이스 객체 상태를 확인하세요." } },
  { from: 5000, to: 9999, info: { name: "Oracle 시스템 오류", description: "데이터베이스 시스템 로그와 운영 상태를 확인하세요." } },
  { from: 10000, to: 19999, info: { name: "SQL 실행 오류", description: "SQL 실행 조건과 접속 상태를 확인하세요." } },
  { from: 20000, to: 32799, info: { name: "애플리케이션 또는 SQL 실행 오류", description: "애플리케이션 처리와 SQL 실행 조건을 확인하세요." } },
  { from: 32800, to: 59999, info: { name: "Oracle 기능 실행 오류", description: "Oracle 기능 실행 중 오류가 발생했습니다. 오류 코드를 확인하세요." } },
  { from: 60000, to: 99999, info: { name: "Oracle 데이터베이스 오류", description: "Oracle 데이터베이스 오류입니다. 오류 코드를 확인하세요." } },
];

export function formatConnectorError(code: string, message: string): string {
  const explanation = ORACLE_ERROR_KOREAN_EXPLANATIONS[code];
  if (explanation !== undefined) {
    return `${code} · ${explanation}`;
  }
  const known = ORACLE_ERROR_CATALOG[code];
  if (known !== undefined) {
    return `${code} · ${known.name}: ${known.description}`;
  }
  const errorNumber = oracleErrorNumber(code);
  if (errorNumber !== undefined) {
    const range = ORACLE_ERROR_RANGES.find(({ from, to }) => errorNumber >= from && errorNumber <= to);
    if (range !== undefined) {
      return `${code} · ${range.info.name}: ${range.info.description}`;
    }
  }
  return `${code}: ${message}`;
}

function oracleErrorNumber(code: string): number | undefined {
  const match = /^ORA-(\d{5})$/u.exec(code);
  return match === null ? undefined : Number(match[1]);
}
