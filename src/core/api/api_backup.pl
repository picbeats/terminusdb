:- module(api_backup, [backup/4, restore/4]).

:- use_module(core(util)).
:- use_module(core(query)).
:- use_module(core(transaction)).
:- use_module(core(triple)).
:- use_module(core(account)).
:- use_module(core(document)).
:- use_module(core(api/api_db)).
:- use_module(core(api/db_create)).
:- use_module(core(api/db_delete)).
:- use_module(core(api/db_pack)).
:- use_module(library(terminus_store)).
:- use_module(library(base64)).
:- use_module(library(http/json)).

backup(System_DB, Auth, Path, Backup) :-
    atomic_list_concat([Path, '/local/_commits'], Repo_Path),
    resolve_absolute_string_descriptor(Repo_Path, Repo_Descriptor),
    askable_context(Repo_Descriptor, System_DB, Auth, Repo_Context),
    repository_context_to_layer(Repo_Context, Repository_Layer),
    layer_to_id(Repository_Layer, Repository_Head),
    repository_layer_to_layerids(Repository_Layer, none, Layer_Ids),
    storage(Store), pack_export(Store, Layer_Ids, Pack),
    atomic_list_concat([Organization, Database], '/', Path),
    list_database(System_DB, Auth, Organization, Database, Database_Record,
                  _{branches: true, verbose: true}),
    database_prefixes(Repo_Context, Prefixes),
    del_dict('@type', Prefixes, _, Prefixes0),
    del_dict('@metadata', Prefixes0, _, Backup_Prefixes),
    Database_Metadata = Database_Record.put(prefixes, Backup_Prefixes),
    base64(Pack, Encoded_Pack),
    Backup = _{database: Database_Metadata, repository_head: Repository_Head,
               pack: Encoded_Pack}.

restore(System_DB, Auth, Path, Payload) :-
    atomic_list_concat([Organization, Database], '/', Path),
    ( is_dict(Payload) -> Backup = Payload ; atom_json_dict(Payload, Backup, []) ),
    get_dict(pack, Backup, Encoded_Pack), base64(Pack_Atom, Encoded_Pack), atom_string(Pack_Atom, Pack),
    get_dict(repository_head, Backup, Repository_Head),
    get_dict(database, Backup, Record), get_dict(label, Record, Label),
    ( get_dict(comment, Record, Comment) -> true ; Comment = 'Restored from backup' ),
    ( get_dict(public, Record, Public) -> true ; Public = false ),
    get_dict(prefixes, Record, Prefixes),
    create_db_unfinalized(System_DB, Auth, Organization, Database, Label, Comment,
                          false, Public, Prefixes, Db_Uri),
    text_to_string(Organization, Org_String), text_to_string(Database, Db_String),
    setup_call_catcher_cleanup(assert(db_currently_creating(Org_String, Db_String)),
        restore_repository(Organization, Database, Db_Uri, Pack, Repository_Head),
        exception(Error),
        ( ignore(retract(db_currently_creating(Org_String, Db_String))),
          force_delete_db(Organization, Database), throw(Error) )),
    ignore(retract(db_currently_creating(Org_String, Db_String))).

restore_repository(Organization, Database, Db_Uri, Pack, Repository_Head) :-
    Descriptor = database_descriptor{organization_name: Organization, database_name: Database},
    create_context(Descriptor, Context),
    with_transaction(Context, ( unpack(Pack), update_repository_head(Context, "local", Repository_Head) ), _),
    finalize_db(Db_Uri).

:- begin_tests(backup_restore).
:- use_module(core(util/test_utils)).
:- use_module(core(api/db_branch)).
test(clean_store_all_branches, [setup(setup_temp_store(State)), cleanup(teardown_temp_store(State))]) :-
    create_db_without_schema(admin, source), open_descriptor(system_descriptor{}, System), super_user_authority(Auth),
    branch_create(System, Auth, "admin/source/local/branch/work", branch("admin/source"), _),
    resolve_absolute_string_descriptor("admin/source/local/branch/work", Work),
    create_context(Work, commit_info{author: "test", message: "work"}, Work_Context),
    with_transaction(Work_Context, ask(Work_Context, insert(a, b, c)), _),
    backup(System, Auth, "admin/source", Backup), assertion(restore(System, Auth, "admin/restored", Backup)),
    resolve_absolute_string_descriptor("admin/source/local/_commits", Source),
    resolve_absolute_string_descriptor("admin/restored/local/_commits", Restored),
    has_branch(Restored, "main"), has_branch(Restored, "work"),
    branch_head_commit(Source, "work", Head), branch_head_commit(Restored, "work", Head).
:- end_tests(backup_restore).
