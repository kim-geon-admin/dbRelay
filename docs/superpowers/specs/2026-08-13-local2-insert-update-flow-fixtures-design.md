# 로컬2 Insert/Update Flow 테스트 케이스 설계

## 목적

같은 Oracle XE를 가리키는 별도 원본·대상 연결 프로필을 사용해 DB Relay의 저장 Flow 다섯 개를 만든다. 각 Flow는 세 단계이고 모든 원본 조회는 사용자, 주소, 내보내기 테이블을 조인한다.

## 연결

기존 `로컬2` 프로필을 원본으로 사용한다. 동일한 연결 정보를 가진 `로컬2-대상` 프로필을 별도 ID로 저장해 대상에 사용한다. 연결 비밀값은 출력하거나 Flow 정의에 기록하지 않는다.

## 단계 규칙

- `operation: "insert"`인 단계의 대상 SQL은 `INSERT`로 시작한다.
- `operation: "update"`인 단계의 대상 SQL은 `UPDATE`로 시작한다.
- 대상 SQL은 `MERGE`를 사용하지 않는다.
- 모든 Flow는 세 개의 순서 있는 단계와 `all_or_nothing` 정책을 가진다.

## 저장 Flow

| ID | 이름 | 결과 | 단계 구성 |
| --- | --- | --- | --- |
| `local2-insert-success` | 로컬2 성공: 신규 사용자 삽입 | 성공 | 사용자 INSERT, 주소 INSERT, 내보내기 INSERT |
| `local2-update-success` | 로컬2 성공: 기존 사용자 갱신 | 성공 | 사용자 UPDATE, 주소 UPDATE, 내보내기 UPDATE |
| `local2-mixed-success` | 로컬2 성공: 혼합 처리 | 성공 | 사용자 UPDATE, 주소 INSERT, 내보내기 INSERT |
| `local2-insert-duplicate-failure` | 로컬2 실패: 사용자 키 중복 | 실패 | 중복 사용자 INSERT, 주소 INSERT, 내보내기 INSERT |
| `local2-address-fk-failure` | 로컬2 실패: 주소 FK 오류 | 실패 | 사용자 UPDATE, 잘못된 사용자 ID의 주소 UPDATE, 내보내기 UPDATE |

성공 INSERT Flow는 기존 대상 행과 겹치지 않는 사용자 11001 이상, 주소 21001 이상, 내보내기 31001 이상의 키를 사용한다. 혼합 Flow의 주소·내보내기 삽입에는 41001 이상과 51001 이상의 키를 사용한다. 실패 Flow는 의도적으로 이미 존재하는 1001 이상 사용자 키 또는 존재하지 않는 사용자 키를 사용하지만, 실행 전까지는 데이터를 변경하지 않는다.

## 저장 검증

로컬 앱 SQLite의 Flow 저장소에 원본·대상 ID가 다른 다섯 Flow를 저장한 뒤, 각 Flow의 단계 수가 세 개인지, operation과 대상 SQL 첫 키워드가 일치하는지, 원본 SQL에 세 테이블 조인이 있는지 확인한다. 실패 Flow는 정의만 저장하며 자동 실행하지 않는다.
