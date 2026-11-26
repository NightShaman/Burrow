// Additive v110 search contract repair. Keep earlier migration bytes immutable.
export const POSTGRES_SESSION_RECALL_RELEVANCE_SQL = String.raw`
CREATE FUNCTION burrow_recall_word_unit(unit text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $recall$
DECLARE code int;
BEGIN
 -- Projections are UTF-16 keys. Treat non-ASCII units conservatively as word
 -- characters; this preserves Unicode token boundaries without decoding NUL.
 IF unit !~ '^00[0-7][0-9a-f]$' THEN RETURN true; END IF;
 code:=('x'||unit)::bit(16)::int;
 RETURN code BETWEEN 48 AND 57 OR code BETWEEN 65 AND 90 OR code BETWEEN 97 AND 122 OR code=95;
END $recall$;

CREATE FUNCTION burrow_recall_exact_match(needle text,haystack text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $recall$
DECLARE at int:=1; found int; start_at int; end_at int; before_unit text; after_unit text;
BEGIN
 IF needle='' THEN RETURN false; END IF;
 LOOP
  found:=burrow_recall_position(needle,substring(haystack FROM (at-1)*4+1));
  IF found=0 THEN RETURN false; END IF;
  start_at:=at+found-1; end_at:=start_at+length(needle)/4;
  before_unit:=CASE WHEN start_at>1 THEN substring(haystack FROM (start_at-2)*4+1 FOR 4) ELSE NULL END;
  after_unit:=substring(haystack FROM (end_at-1)*4+1 FOR 4);
  IF (before_unit IS NULL OR NOT burrow_recall_word_unit(before_unit))
   AND (after_unit='' OR NOT burrow_recall_word_unit(after_unit)) THEN RETURN true; END IF;
  at:=start_at+1;
 END LOOP;
END $recall$;

DROP FUNCTION burrow_recall_score(text,int,text,text[]);
CREATE FUNCTION burrow_recall_score(haystack text,rank_weight int,exact text,terms text[])
 RETURNS TABLE(matches boolean,score int,denial boolean,exact_match boolean) LANGUAGE plpgsql IMMUTABLE AS $recall$
DECLARE term text; pos int; count int:=0; lo int:=2147483647; hi int:=0;
BEGIN
 denial:=false; exact_match:=false;
 IF exact<>'' AND burrow_recall_exact_match(exact,haystack) THEN
  matches:=true; exact_match:=true; score:=2000;
 ELSIF cardinality(terms)=0 THEN matches:=true; score:=0;
 ELSE
  FOREACH term IN ARRAY terms LOOP
   pos:=burrow_recall_position(term,haystack);
   IF pos>0 THEN count:=count+1; lo:=least(lo,pos); hi:=greatest(hi,pos); END IF;
  END LOOP;
  matches:=count>=least(2,cardinality(terms));
  score:=CASE WHEN count=cardinality(terms) THEN 700 ELSE 0 END
   +round(count::numeric/cardinality(terms)*400)::int+count*20
   +CASE WHEN count>1 THEN greatest(0,100-(hi-lo)/8) ELSE 0 END;
 END IF;
 score:=score+rank_weight;
 RETURN NEXT;
END $recall$;
`;
