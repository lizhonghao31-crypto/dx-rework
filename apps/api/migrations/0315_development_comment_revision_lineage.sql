-- The immutable comment is not consumed forever. An explicit new intent may
-- start only from its latest, actually published revision target.
ALTER TABLE digital_development_revision_comment_adoptions
 DROP CONSTRAINT digital_development_revision_comment_adoptions_comment_id_key,
 ADD COLUMN adoption_number integer NOT NULL DEFAULT 1 CHECK (adoption_number>0),
 ADD COLUMN previous_source_id uuid,
 ADD COLUMN previous_round_number integer,
 ADD CONSTRAINT development_comment_adoption_number UNIQUE(comment_id,adoption_number),
 ADD CONSTRAINT development_comment_adoption_previous FOREIGN KEY(previous_source_id,previous_round_number)
  REFERENCES digital_development_revision_comment_adoptions(source_id,round_number) MATCH FULL,
 ADD CONSTRAINT development_comment_adoption_lineage_shape CHECK ((adoption_number=1)=(previous_source_id IS NULL));

CREATE FUNCTION guard_development_revision_comment_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous digital_development_revision_comment_adoptions%ROWTYPE;
BEGIN
 IF NEW.adoption_number=1 THEN RETURN NEW; END IF;
 SELECT * INTO previous FROM digital_development_revision_comment_adoptions
 WHERE comment_id=NEW.comment_id ORDER BY adoption_number DESC LIMIT 1;
 IF previous.source_id IS NULL OR previous.adoption_number+1<>NEW.adoption_number
   OR previous.source_id IS DISTINCT FROM NEW.previous_source_id
   OR previous.round_number IS DISTINCT FROM NEW.previous_round_number
   OR NOT EXISTS(SELECT 1 FROM digital_development_documents d WHERE d.source_id=previous.source_id AND d.status='published')
   OR NOT ( (NEW.source_id=previous.source_id AND NEW.round_number>previous.round_number)
     OR EXISTS(SELECT 1 FROM digital_development_revision_sources related
       WHERE related.source_id=NEW.source_id AND related.parent_source_id=previous.source_id
         AND related.parent_round>=previous.round_number)) THEN
   RAISE EXCEPTION 'A repeated comment adoption requires its latest published revision target' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER digital_development_revision_comment_lineage_guard BEFORE INSERT ON digital_development_revision_comment_adoptions
 FOR EACH ROW EXECUTE FUNCTION guard_development_revision_comment_lineage();
