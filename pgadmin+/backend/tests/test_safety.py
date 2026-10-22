import pytest

from app.pg.safety import DESTRUCTIVE, READ, WRITE, classify, is_read_only
from app.pg.sqltext import mask, split_statements


def test_split_basic():
    assert split_statements("select 1; select 2;") == ["select 1", "select 2"]


def test_split_ignores_semicolons_in_literals_and_comments():
    sql = """
    select 'a;b', "we;ird", E'it\\'s;' ; -- comment; here
    /* block ; /* nested ; */ still */ select 2;
    create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql;
    select $$x;y$$
    """
    stmts = split_statements(sql)
    assert len(stmts) == 4
    assert stmts[2].startswith("create function")
    assert stmts[3] == "select $$x;y$$"


def test_split_drops_comment_only_statements():
    assert split_statements("-- just a comment\n;  ; /* x */") == []


def test_mask_preserves_length():
    sql = "select 'x' -- c\n"
    assert len(mask(sql)) == len(sql)


@pytest.mark.parametrize(
    "sql,kind",
    [
        ("SELECT * FROM t", READ),
        ("with x as (select 1) select * from x", READ),
        ("show work_mem", READ),
        ("explain select 1", READ),
        ("explain analyze select 1", READ),
        ("explain analyze delete from t where id = 1", WRITE),
        ("with d as (delete from t where id=1 returning *) select * from d", WRITE),
        ("select * into newt from t", WRITE),
        ("insert into t values (1)", WRITE),
        ("update t set a = 1 where id = 2", WRITE),
        ("create index on t(a)", WRITE),
        ("delete from t where id = 1", WRITE),
        ("delete from t", DESTRUCTIVE),
        ("update t set a = (select max(b) from u where u.x = 1)", DESTRUCTIVE),
        ("drop table t", DESTRUCTIVE),
        ("truncate t", DESTRUCTIVE),
        ("alter table t drop column a", DESTRUCTIVE),
        ("select 'drop table t'", READ),
        ("-- drop table t\nselect 1", READ),
    ],
)
def test_classify(sql, kind):
    assert classify(sql).kind == kind


def test_is_read_only_requires_all_statements_read():
    assert is_read_only("select 1; select 2")
    assert not is_read_only("select 1; delete from t where id = 1")
    assert not is_read_only("")
