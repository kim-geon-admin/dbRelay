## # edit flow 화면 수정사항

- [x] 1.sql 입력창에서 ctrl+f누르면 sql type formating변경
- [x] 2.미리보기, run 버튼은 다른 버튼과 다르게 하얀색 외에 다른 색으로  표현
- [x] 3.미리보기창이 열린 상태에서 부모쪽 컨트롤 안되도록  예) 스크롤
- [x] 4.run을 동작한 상태라면 commit 까지 자동 실행
- [x] 5.미리보기창은 컬럼 갯수 및 data rows에 맞춰서 width height 조정  

      = &gt; 미리보기창은 앱 화면 크기의 80% 넘어가지도 않도록 하고 정중앙 위치

- [x] 6. 미리보기상태의 데이터를 사용자가 직접 edit 할 수 있는 기능 추가
- [x] 7. 미리보기화면 우측 상단에 저장 버튼 추가  

      = &gt; 저장버튼의 기능은 source sql에 조회된 데이터를 6번에서 처럼 사용자가 수정을 하게 되면   
        기본적으로 source sql에서 데이터 조회 후 그 데이터를 target sql 에 바인딩을 통해서 dml을 하는 기능을  
         저장된 데이터를 target sql 바인딩 데이터로 활용하여 dml 처리  
        저장버튼을 클릭 했을 경우 부모창에서  "사용자가 변경한 데이터로 DML 처리 합니다" 라는 문구를 표시   
- [x] 8. operation 에서 upsert 도 기능 추가하고 inser 나 update 처럼 가이드 sql을 만들어줘

       update 나 , upsert의 경우에는 pk key 를 확인해서 가이드 sql 생성시 where조건에 기본으로 넣어줘

      pk key 확인하는 테이블은 all_ind_columns 를 참고해  그리고 upsert의 경우에는 테이블이 여러개 쿼리문에 작성되니 확인해서 update 문에 정확히 기입해줘



## #실행이력 수정사항

- [ ]  1. 실행이력 ui  frame 은 좌우 분할이 아니라 db설정이나 쿼리시퀀스 처럼 list형태로 출력 및 해당 로그 클릭 후 상세정보 보기
- [ ] 2. 실행id는 edit flow name과 동작시간을 보여주는걸로 변경 



&nbsp;
